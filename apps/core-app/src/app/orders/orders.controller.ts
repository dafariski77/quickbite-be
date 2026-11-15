import {
  Controller,
  Post,
  Patch,
  Get,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { KdsService } from '../kds/kds.service';

@Controller('v1/orders')
export class OrdersController {
  constructor(
    private readonly ordersService: OrdersService,
    private readonly kdsService: KdsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createOrder(@Body() dto: CreateOrderDto) {
    const order = await this.ordersService.createOrder(dto);
    return {
      statusCode: HttpStatus.CREATED,
      message: 'Order created and pickup slot reserved successfully',
      data: order,
    };
  }

  @Patch(':id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelOrder(@Param('id', new ParseUUIDPipe()) id: string) {
    const result = await this.ordersService.cancelOrder(id);
    return {
      statusCode: HttpStatus.OK,
      message: result.message,
      data: result,
    };
  }

  @Get('recent')
  @HttpCode(HttpStatus.OK)
  async getUserRecentOrders(
    @Query('userId', new ParseUUIDPipe()) userId: string,
  ) {
    const orders = await this.ordersService.getUserRecentOrders(userId);
    return {
      statusCode: HttpStatus.OK,
      message: 'User recent orders retrieved successfully',
      data: orders,
    };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  async getOrderById(@Param('id', new ParseUUIDPipe()) id: string) {
    const order = await this.ordersService.getOrderById(id);
    return {
      statusCode: HttpStatus.OK,
      message: 'Order details retrieved successfully',
      data: order,
    };
  }

  /**
   * GET /api/v1/orders/:id/stream
   * SSE stream for real-time order status updates (iOS Live Activity).
   * Receives order.ready events from KdsService via EventEmitter.
   */
  @Get(':id/stream')
  streamOrderStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): void {
    this.kdsService.addOrderClient(id, res);
  }

  /**
   * PATCH /api/v1/orders/:id/complete
   * US-5.1: Employee confirms pickup — transitions READY_FOR_PICKUP → COMPLETED.
   */
  @Patch(':id/complete')
  @HttpCode(HttpStatus.OK)
  async completeOrder(@Param('id', new ParseUUIDPipe()) id: string) {
    const order = await this.ordersService.completeOrder(id);
    return {
      statusCode: HttpStatus.OK,
      message: 'Order marked as completed. Enjoy your meal!',
      data: order,
    };
  }
}
