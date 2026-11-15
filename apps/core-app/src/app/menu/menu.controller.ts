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
import { MenuService } from './menu.service';
import { GetMenuQueryDto } from './dto/get-menu.dto';

@Controller('v1/menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get('today')
  @HttpCode(HttpStatus.OK)
  async getTodayMenu(@Query() query: GetMenuQueryDto) {
    const data = await this.menuService.getTodayMenu(query);
    return {
      statusCode: HttpStatus.OK,
      message: "Today's menu retrieved successfully",
      data,
    };
  }

  @Patch(':id/stock')
  @HttpCode(HttpStatus.OK)
  async toggleStock(
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
