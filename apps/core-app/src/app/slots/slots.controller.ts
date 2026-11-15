import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { SlotsService } from './slots.service';
import { UpdateSlotCapacityDto } from './dto/update-slot.dto';

@Controller('v1/slots')
export class SlotsController {
  constructor(private readonly slotsService: SlotsService) {}

  @Get('today')
  @HttpCode(HttpStatus.OK)
  async getTodaySlots(@Query('referenceTime') referenceTimeStr?: string) {
    const referenceTime = referenceTimeStr
      ? new Date(referenceTimeStr)
      : new Date();

    const data = await this.slotsService.getTodaySlots(referenceTime);
    return {
      statusCode: HttpStatus.OK,
      message: "Today's pickup slots retrieved successfully",
      data,
    };
  }

  @Patch(':id/capacity')
  @HttpCode(HttpStatus.OK)
  async updateSlotCapacity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSlotCapacityDto,
  ) {
    const updated = await this.slotsService.updateSlotCapacity(
      id,
      dto.maxCapacity,
    );
    return {
      statusCode: HttpStatus.OK,
      message: `Pickup slot capacity updated to ${dto.maxCapacity}`,
      data: updated,
    };
  }
}
