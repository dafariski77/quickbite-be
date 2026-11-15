import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Job } from 'bullmq';
import { PrismaService, OrderStatus } from '@micro/core';
import {
  JIT_FIRE_QUEUE,
  JIT_FIRE_JOB,
} from '../constants';
import {
  OrderFiredEvent,
  ORDER_FIRED_EVENT,
} from '../events/order.events';

interface JitFireJobData {
  orderId: string;
}

@Processor(JIT_FIRE_QUEUE)
export class JitFireProcessor extends WorkerHost {
  private readonly logger = new Logger(JitFireProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    super();
  }

  async process(job: Job<JitFireJobData>): Promise<void> {
    const { orderId } = job.data;

    if (job.name !== JIT_FIRE_JOB) {
      this.logger.warn(`Unknown job name: ${job.name}. Skipping.`);
      return;
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { slot: true },
    });

    if (!order) {
      this.logger.warn(`⚠️  JIT fire skipped — Order ${orderId} not found`);
      return;
    }

    // Guard: skip if order is not in SCHEDULED state (e.g., already cancelled)
    if (order.status !== OrderStatus.SCHEDULED) {
      this.logger.log(
        `⚠️  JIT fire skipped — Order #${order.pickupCode} is already in ${order.status} state`,
      );
      return;
    }

    // Transition to PREPARING
    await this.prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.PREPARING },
    });

    // Emit event for KDS SSE broadcasting
    const event = new OrderFiredEvent(
      order.id,
      order.pickupCode,
      order.userId,
      order.slotId,
      order.pickupZone,
    );
    this.eventEmitter.emit(ORDER_FIRED_EVENT, event);

    this.logger.log(
      `🔥 Ticket fired — Order #${order.pickupCode} → PREPARING (slot: ${order.slot.startTime.toISOString()})`,
    );
  }
}
