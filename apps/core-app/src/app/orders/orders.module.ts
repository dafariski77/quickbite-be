import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { KdsModule } from '../kds/kds.module';

@Module({
  imports: [SchedulerModule, KdsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
