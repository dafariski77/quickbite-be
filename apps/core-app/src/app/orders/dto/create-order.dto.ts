import {
  IsUUID,
  IsArray,
  ValidateNested,
  IsInt,
  Min,
  IsObject,
  ArrayMinSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class OrderItemDto {
  @IsUUID('4', { message: 'menuItemId must be a valid UUID' })
  menuItemId!: string;

  @IsInt()
  @Min(1, { message: 'quantity must be at least 1' })
  quantity!: number;

  @IsObject()
  selectedModifiers!: Record<string, string>;
}

export class CreateOrderDto {
  @IsUUID('4', { message: 'userId must be a valid UUID' })
  userId!: string;

  @IsUUID('4', { message: 'slotId must be a valid UUID' })
  slotId!: string;

  @IsArray()
  @ArrayMinSize(1, { message: 'Order must contain at least one item' })
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];
}
