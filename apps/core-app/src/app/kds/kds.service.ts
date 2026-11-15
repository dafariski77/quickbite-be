import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Response } from 'express';
import { PrismaService, OrderStatus } from '@micro/core';
import {
  OrderFiredEvent,
  OrderReadyEvent,
  ORDER_FIRED_EVENT,
  ORDER_READY_EVENT,
} from '../scheduler/events/order.events';

@Injectable()
export class KdsService {
  private readonly logger = new Logger(KdsService.name);

  /**
   * Active KDS SSE clients (kitchen tablets).
   * Each entry holds the Express Response stream for one connected tablet.
   */
  private readonly kdsClients = new Set<Response>();

  /**
   * Active order SSE clients (iOS Live Activity streams), keyed by orderId.
   */
  private readonly orderClients = new Map<string, Set<Response>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─── Forecast ────────────────────────────────────────────────────────────────

  /**
   * Returns aggregated item counts per upcoming slot for batch kitchen prep.
   * Only includes SCHEDULED and PREPARING orders for today's remaining slots.
   */
  async getForecast() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now);
    todayEnd.setHours(23, 59, 59, 999);

    // Fetch all upcoming slots with their active orders
    const slots = await this.prisma.pickupSlot.findMany({
      where: {
        serviceDate: { gte: todayStart, lte: todayEnd },
        startTime: { gte: now }, // only upcoming slots
      },
      orderBy: { startTime: 'asc' },
      include: {
        orders: {
          where: {
            status: { in: [OrderStatus.SCHEDULED, OrderStatus.PREPARING] },
          },
          include: {
            orderItems: {
              include: { menuItem: true },
            },
          },
        },
      },
    });

    // Aggregate: { slotId → { startTime, endTime, items: { menuItemId → { name, qty } } } }
    return slots.map((slot) => {
      const itemTotals: Record<
        string,
        { menuItemId: string; name: string; category: string; totalQuantity: number }
      > = {};

      for (const order of slot.orders) {
        for (const oi of order.orderItems) {
          if (!itemTotals[oi.menuItemId]) {
            itemTotals[oi.menuItemId] = {
              menuItemId: oi.menuItemId,
              name: oi.menuItem.name,
              category: oi.menuItem.category,
              totalQuantity: 0,
            };
          }
          itemTotals[oi.menuItemId].totalQuantity += oi.quantity;
        }
      }

      return {
        slotId: slot.id,
        startTime: slot.startTime,
        endTime: slot.endTime,
        totalOrders: slot.orders.length,
        items: Object.values(itemTotals),
      };
    });
  }

  // ─── Mark Ready ──────────────────────────────────────────────────────────────

  /**
   * Transitions an order from PREPARING → READY_FOR_PICKUP.
   * Sets readyAt timestamp. Emits order.ready event for iOS push + SSE.
   */
  async markOrderReady(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { slot: true, user: { select: { id: true, employeeCode: true } } },
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    if (order.status !== OrderStatus.PREPARING) {
      throw new BadRequestException(
        `Order #${order.pickupCode} cannot be marked ready — current status is ${order.status}`,
      );
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status: OrderStatus.READY_FOR_PICKUP,
        readyAt: new Date(),
      },
      include: {
        slot: true,
        orderItems: { include: { menuItem: true } },
      },
    });

    // Emit event: triggers iOS push (future APNs integration) + SSE to iOS client
    const event = new OrderReadyEvent(
      order.id,
      order.pickupCode,
      order.userId,
      order.pickupZone,
    );
    this.eventEmitter.emit(ORDER_READY_EVENT, event);

    this.logger.log(
      `✅ Order #${order.pickupCode} marked READY_FOR_PICKUP (Zone: ${order.pickupZone})`,
    );

    return updatedOrder;
  }

  // ─── KDS SSE Stream ──────────────────────────────────────────────────────────

  /**
   * Registers a kitchen tablet as an SSE client and keeps the connection alive.
   * Receives ticket_fired events from the JIT processor via EventEmitter.
   */
  addKdsClient(res: Response): void {
    this.initSseHeaders(res);
    this.kdsClients.add(res);
    this.logger.log(`KDS client connected. Total: ${this.kdsClients.size}`);

    // Send a heartbeat immediately so iOS/tablet knows stream is alive
    this.sendSseEvent(res, 'connected', { message: 'KDS stream connected' });

    res.on('close', () => {
      this.kdsClients.delete(res);
      this.logger.log(`KDS client disconnected. Total: ${this.kdsClients.size}`);
    });
  }

  /** Receives order.fired from JitFireProcessor and broadcasts to all KDS tablets. */
  @OnEvent(ORDER_FIRED_EVENT)
  handleOrderFired(event: OrderFiredEvent): void {
    this.logger.log(`📺 Broadcasting ticket_fired to ${this.kdsClients.size} KDS client(s)`);
    this.broadcastToKds('ticket_fired', event);
  }

  // ─── Order SSE Stream (iOS Live Activity) ───────────────────────────────────

  /**
   * Registers an iOS client listening for status updates on a specific order.
   */
  addOrderClient(orderId: string, res: Response): void {
    this.initSseHeaders(res);

    if (!this.orderClients.has(orderId)) {
      this.orderClients.set(orderId, new Set());
    }
    this.orderClients.get(orderId)!.add(res);
    this.logger.log(`iOS client connected for order ${orderId}`);

    this.sendSseEvent(res, 'connected', { orderId, message: 'Order stream connected' });

    res.on('close', () => {
      this.orderClients.get(orderId)?.delete(res);
      if (this.orderClients.get(orderId)?.size === 0) {
        this.orderClients.delete(orderId);
      }
      this.logger.log(`iOS client disconnected for order ${orderId}`);
    });
  }

  /** Receives order.ready and pushes status update to the specific order's SSE clients. */
  @OnEvent(ORDER_READY_EVENT)
  handleOrderReady(event: OrderReadyEvent): void {
    this.broadcastToOrder(event.orderId, 'order_ready', event);
  }

  // ─── SSE Helpers ─────────────────────────────────────────────────────────────

  private initSseHeaders(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
    res.flushHeaders();
  }

  private sendSseEvent(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private broadcastToKds(event: string, data: unknown): void {
    for (const client of this.kdsClients) {
      this.sendSseEvent(client, event, data);
    }
  }

  private broadcastToOrder(orderId: string, event: string, data: unknown): void {
    const clients = this.orderClients.get(orderId);
    if (!clients) return;
    for (const client of clients) {
      this.sendSseEvent(client, event, data);
    }
  }
}
