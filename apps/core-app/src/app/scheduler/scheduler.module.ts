import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { redisConnection } from './redis.config';
import { JIT_FIRE_QUEUE, ORDER_EXPIRY_QUEUE } from './constants';
import { SchedulerService } from './scheduler.service';
import { JitFireProcessor } from './processors/jit-fire.processor';
import { OrderExpiryProcessor } from './processors/order-expiry.processor';

@Module({
  imports: [
    BullModule.forRoot({
      connection: redisConnection,
    }),
    BullModule.registerQueue(
      { name: JIT_FIRE_QUEUE },
      { name: ORDER_EXPIRY_QUEUE },
    ),
  ],
  providers: [SchedulerService, JitFireProcessor, OrderExpiryProcessor],
  exports: [SchedulerService],
})
export class SchedulerModule {}
