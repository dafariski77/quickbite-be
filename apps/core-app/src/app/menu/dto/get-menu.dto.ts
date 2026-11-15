import { IsEnum, IsOptional } from 'class-validator';
import { Category } from '@micro/core';

export class GetMenuQueryDto {
  @IsOptional()
  @IsEnum(Category, {
    message: 'category must be HOT_MEAL, COLD_DRINK, or SNACK',
  })
  category?: Category;
}
