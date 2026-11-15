import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { PrismaService, OrderStatus } from '@micro/core';
import {
  ORDER_EXPIRY_QUEUE,
  ORDER_REMINDER_JOB,
  ORDER_EXPIRY_JOB,
} from '../constants';
import {
  OrderReminderEvent,
  OrderExpiredEvent,
  ORDER_REMINDER_EVENT,
  ORDER_EXPIRED_EVENT,
} from '../events/order.events';

interface OrderExpiryJobData {
  orderId: string;
}

@Processor(ORDER_EXPIRY_QUEUE)
export class OrderExpiryProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderExpiryProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<OrderExpiryJobData>): Promise<void> {
    const { orderId } = job.data;

    if (job.name === ORDER_REMINDER_JOB) {
      await this.handleReminder(orderId);
    } else if (job.name === ORDER_EXPIRY_JOB) {
      await this.handleExpiry(orderId);
    } else {
      this.logger.warn(`Unknown job name: ${job.name}. Skipping.`);
    }
  }

  /**
   * 20-minute reminder: triggers push notification if order is still READY_FOR_PICKUP.
   */
  private async handleReminder(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      this.logger.warn(`⚠️  Reminder skipped — Order ${orderId} not found`);
      return;
    }

    if (order.status !== OrderStatus.READY_FOR_PICKUP) {
      this.logger.log(
        `⚠️  Reminder skipped — Order #${order.pickupCode} is in ${order.status} state`,
      );
      return;
    }

    const event = new OrderReminderEvent(order.id, order.pickupCode, order.userId);
    this.eventEmitter.emit(ORDER_REMINDER_EVENT, event);

    this.logger.log(`🔔 Pickup reminder emitted — Order #${order.pickupCode}`);
  }

  /**
   * 30-minute auto-expiry: transitions READY_FOR_PICKUP → EXPIRED (US-6.2).
   */
  private async handleExpiry(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });

    if (!order) {
      this.logger.warn(`⚠️  Expiry skipped — Order ${orderId} not found`);
      return;
    }

    if (order.status !== OrderStatus.READY_FOR_PICKUP) {
      this.logger.log(
        `⚠️  Expiry skipped — Order #${order.pickupCode} is in ${order.status} state`,
      );
      return;
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.EXPIRED },
    });

    const event = new OrderExpiredEvent(order.id, order.pickupCode);
    this.eventEmitter.emit(ORDER_EXPIRED_EVENT, event);

    this.logger.log(`⌛ Order #${order.pickupCode} auto-expired after 30 minutes`);
  }
}
