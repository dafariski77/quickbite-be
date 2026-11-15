import { IsInt, Min, Max } from 'class-validator';

export class UpdateSlotCapacityDto {
  @IsInt()
  @Min(1)
  @Max(100)
  maxCapacity!: number;
}
