import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import { KdsService } from './kds.service';
import { MenuService } from '../menu/menu.service';

@Controller('v1/kds')
export class KdsController {
  constructor(
    private readonly kdsService: KdsService,
    private readonly menuService: MenuService,
  ) {}

  /**
   * GET /api/v1/kds/forecast
   * Returns item counts aggregated per upcoming slot for batch prep (KDS Prep Forecast tab).
   */
  @Get('forecast')
  @HttpCode(HttpStatus.OK)
  async getForecast() {
    const data = await this.kdsService.getForecast();
    return {
      statusCode: HttpStatus.OK,
      message: 'Kitchen prep forecast retrieved successfully',
      data,
    };
  }

  /**
   * GET /api/v1/kds/stream
   * SSE endpoint for the KDS active ticket queue. Streams ticket_fired events to kitchen tablets.
   */
  @Get('stream')
  streamKds(@Res() res: Response): void {
    this.kdsService.addKdsClient(res);
  }

  /**
   * PATCH /api/v1/kds/orders/:id/ready
   * Kitchen staff marks an order READY_FOR_PICKUP after plating.
   * Triggers iOS SSE update and future APNs push.
   */
  @Patch('orders/:id/ready')
  @HttpCode(HttpStatus.OK)
  async markOrderReady(@Param('id', new ParseUUIDPipe()) id: string) {
    const order = await this.kdsService.markOrderReady(id);
    return {
      statusCode: HttpStatus.OK,
      message: `Order #${order.pickupCode} is ready for pickup`,
      data: order,
    };
  }

  /**
   * PATCH /api/v1/kds/menu/:id/stock
   * PRD §5.4 — KDS staff 86s a sold-out item in real time.
   * Immediately removes item from employee ordering screens.
   */
  @Patch('menu/:id/stock')
  @HttpCode(HttpStatus.OK)
  async toggleMenuStock(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body('isAvailable') isAvailable: boolean,
  ) {
    const updated = await this.menuService.toggleItemStock(id, isAvailable);
    return {
      statusCode: HttpStatus.OK,
      message: `Menu item availability updated to ${isAvailable}`,
      data: updated,
    };
  }
}
