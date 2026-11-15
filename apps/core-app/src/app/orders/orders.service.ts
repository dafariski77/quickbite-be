import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import {
  PrismaService,
  OrderStatus,
  PickupZone,
  ModifierSchemaItem,
} from '@micro/core';
import { CreateOrderDto } from './dto/create-order.dto';
import { SchedulerService } from '../scheduler/scheduler.service';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly schedulerService: SchedulerService,
  ) {}

  async createOrder(dto: CreateOrderDto) {
    const now = new Date();

    // 1. Verify user exists
    const user = await this.prisma.user.findUnique({
      where: { id: dto.userId },
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${dto.userId} not found`);
    }

    // 2. Fetch and validate all menu items
    const itemIds = dto.items.map((i) => i.menuItemId);
    const menuItems = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds } },
    });

    if (menuItems.length !== itemIds.length) {
      throw new BadRequestException('One or more menu items are invalid');
    }

    const menuItemsMap = new Map(menuItems.map((item) => [item.id, item]));

    // Validate stock and structured modifiers
    for (const itemDto of dto.items) {
      const menuItem = menuItemsMap.get(itemDto.menuItemId)!;

      if (!menuItem.isAvailable) {
        throw new BadRequestException(
          `Item "${menuItem.name}" is currently sold out and cannot be ordered`,
        );
      }

      // Validate modifiers against schema
      const schema = (menuItem.modifiersSchema as unknown as ModifierSchemaItem[]) || [];
      const selected = itemDto.selectedModifiers || {};

      for (const modifier of schema) {
        const selectedValue = selected[modifier.id];

        if (modifier.required && !selectedValue) {
          throw new BadRequestException(
            `Modifier "${modifier.name}" is required for item "${menuItem.name}"`,
          );
        }

        if (selectedValue && !modifier.options.includes(selectedValue)) {
          throw new BadRequestException(
            `Invalid option "${selectedValue}" for modifier "${modifier.name}". Allowed options: ${modifier.options.join(
              ', ',
            )}`,
          );
        }
      }
    }

    // 3. Atomic Transaction for Slot Reservation & Order Creation
    const createdOrder = await this.prisma.$transaction(async (tx) => {
      // A. Verify Slot and Lead Buffer (5 minutes before slot start)
      const slot = await tx.pickupSlot.findUnique({
        where: { id: dto.slotId },
      });

      if (!slot) {
        throw new NotFoundException(`Pickup slot with ID ${dto.slotId} not found`);
      }

      const leadBufferMs = 5 * 60 * 1000;
      if (now.getTime() > slot.startTime.getTime() - leadBufferMs) {
        throw new ConflictException(
          'SLOT_CLOSED: This pickup slot is no longer open for reservations',
        );
      }

      // B. Atomic conditional increment to prevent overbooking race conditions
      const updateResult = await tx.$queryRaw<
        Array<{ id: string; booked_count: number; max_capacity: number }>
      >`
        UPDATE pickup_slots
        SET booked_count = booked_count + 1
        WHERE id = ${dto.slotId}::uuid
          AND booked_count < max_capacity
        RETURNING id, booked_count, max_capacity;
      `;

      if (!updateResult || updateResult.length === 0) {
        throw new ConflictException(
          'SLOT_FULL: This pickup slot has reached full capacity. Please choose another slot.',
        );
      }

      // C. Calculate JIT Fire Time & Pickup Zone
      let maxPrepDuration = 5;
      let primaryZone: PickupZone = PickupZone.SHELF_A;

      for (const itemDto of dto.items) {
        const item = menuItemsMap.get(itemDto.menuItemId)!;
        if (item.prepDurationMins > maxPrepDuration) {
          maxPrepDuration = item.prepDurationMins;
          primaryZone = item.pickupZone;
        }
      }

      // Fire Time = Slot Start Time - Max Item Prep Duration
      const fireAt = new Date(
        slot.startTime.getTime() - maxPrepDuration * 60 * 1000,
      );

      // 4-digit pickup code
      const pickupCode = Math.floor(1000 + Math.random() * 9000).toString();

      // D. Create Order and OrderItems
      const order = await tx.order.create({
        data: {
          pickupCode,
          userId: dto.userId,
          slotId: dto.slotId,
          status: OrderStatus.SCHEDULED,
          fireAt,
          pickupZone: primaryZone,
          orderItems: {
            create: dto.items.map((item) => ({
              menuItemId: item.menuItemId,
              quantity: item.quantity,
              selectedModifiers: item.selectedModifiers,
            })),
          },
        },
        include: {
          slot: true,
          orderItems: {
            include: {
              menuItem: true,
            },
          },
        },
      });

      this.logger.log(
        `✅ Order #${order.pickupCode} created for user ${user.employeeCode}. Slot: ${slot.startTime.toISOString()}, FireAt: ${fireAt.toISOString()}`,
      );

      return order;
    });

    // Enqueue JIT fire job and expiry jobs after the transaction succeeds
    // (outside the transaction so queue errors don't roll back the reservation)
    await Promise.all([
      this.schedulerService.enqueueJitFireJob(createdOrder.id, createdOrder.fireAt),
      this.schedulerService.enqueueExpiryJobs(createdOrder.id, createdOrder.slot.startTime),
    ]);

    return createdOrder;
  }

  async cancelOrder(orderId: string) {
    const now = new Date();

    return await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { id: orderId },
        include: { slot: true },
      });

      if (!order) {
        throw new NotFoundException(`Order with ID ${orderId} not found`);
      }

      if (order.status !== OrderStatus.SCHEDULED) {
        throw new BadRequestException(
          `Order cannot be cancelled because it is already in ${order.status} state`,
        );
      }

      // Check 15-minute modification cutoff (US-6.1)
      const fifteenMinsMs = 15 * 60 * 1000;
      const isLateCancel =
        now.getTime() > order.slot.startTime.getTime() - fifteenMinsMs;

      // Update Order Status
      const updatedOrder = await tx.order.update({
        where: { id: orderId },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: now,
          isLateCancel,
        },
      });

      // Atomically decrement slot bookedCount
      await tx.$executeRaw`
        UPDATE pickup_slots
        SET booked_count = GREATEST(0, booked_count - 1)
        WHERE id = ${order.slotId}::uuid;
      `;

      this.logger.log(
        `Order #${order.pickupCode} cancelled (Late cancel: ${isLateCancel}). Slot capacity released.`,
      );

      return {
        ...updatedOrder,
        isLateCancel,
        message: isLateCancel
          ? 'Order cancelled within 15-minute window; late cancellation logged.'
          : 'Order cancelled successfully; pickup slot released.',
      };
    });
  }

  async getOrderById(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        slot: true,
        user: {
          select: {
            id: true,
            employeeCode: true,
            fullName: true,
          },
        },
        orderItems: {
          include: {
            menuItem: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    return order;
  }

  async getUserRecentOrders(userId: string, limit = 3) {
    return this.prisma.order.findMany({
      where: {
        userId,
        status: { not: OrderStatus.CANCELLED },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        slot: true,
        orderItems: {
          include: {
            menuItem: true,
          },
        },
      },
    });
  }

  /**
   * US-5.1: Employee confirms pickup → transitions READY_FOR_PICKUP → COMPLETED.
   * Sets completedAt timestamp.
   */
  async completeOrder(orderId: string) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    if (order.status !== OrderStatus.READY_FOR_PICKUP) {
      throw new BadRequestException(
        `Order #${order.pickupCode} cannot be completed — current status is ${order.status}`,
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.COMPLETED,
        completedAt: new Date(),
      },
    });

    this.logger.log(`🎉 Order #${order.pickupCode} marked COMPLETED by employee`);

    return updated;
  }
}
