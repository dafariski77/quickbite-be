import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from '@micro/core';
import { MenuModule } from './menu/menu.module';
import { SlotsModule } from './slots/slots.module';
import { OrdersModule } from './orders/orders.module';
import { KdsModule } from './kds/kds.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    PrismaModule,
    MenuModule,
    SlotsModule,
    OrdersModule,
    KdsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
