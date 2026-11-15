import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService, Category, MenuItem } from '@micro/core';
import { GetMenuQueryDto } from './dto/get-menu.dto';

@Injectable()
export class MenuService {
  constructor(private readonly prisma: PrismaService) {}

  async getTodayMenu(query?: GetMenuQueryDto) {
    const where: { category?: Category } = {};
    if (query?.category) {
      where.category = query.category;
    }

    const items = await this.prisma.menuItem.findMany({
      where,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    const categories = Object.values(Category);

    return {
      categories,
      totalCount: items.length,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        category: item.category,
        prepDurationMins: item.prepDurationMins,
        pickupZone: item.pickupZone,
        isAvailable: item.isAvailable,
        modifiersSchema: item.modifiersSchema,
      })),
    };
  }

  async toggleItemStock(id: string, isAvailable: boolean): Promise<MenuItem> {
    const existing = await this.prisma.menuItem.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException(`Menu item with ID ${id} not found`);
    }

    return this.prisma.menuItem.update({
      where: { id },
      data: { isAvailable },
    });
  }
}
