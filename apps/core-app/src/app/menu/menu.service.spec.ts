import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MenuService } from './menu.service';
import { PrismaService, Category, PickupZone } from '@micro/core';

describe('MenuService', () => {
  let service: MenuService;

  const mockMenuItems = [
    {
      id: 'item-uuid-1',
      name: 'Grilled Teriyaki Chicken Bowl',
      category: Category.HOT_MEAL,
      prepDurationMins: 6,
      pickupZone: PickupZone.SHELF_A,
      isAvailable: true,
      modifiersSchema: [
        {
          id: 'spice',
          name: 'Spice Level',
          required: true,
          options: ['Mild', 'Spicy'],
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    {
      id: 'item-uuid-2',
      name: 'Artisan Iced Latte',
      category: Category.COLD_DRINK,
      prepDurationMins: 2,
      pickupZone: PickupZone.DRINK_COUNTER,
      isAvailable: false, // 86'd / Sold out
      modifiersSchema: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  ];

  const mockPrismaService = {
    menuItem: {
      findMany: jest.fn().mockImplementation(({ where }) => {
        if (where?.category) {
          return Promise.resolve(
            mockMenuItems.filter((item) => item.category === where.category),
          );
        }
        return Promise.resolve(mockMenuItems);
      }),
      findUnique: jest.fn().mockImplementation(({ where }) => {
        const found = mockMenuItems.find((i) => i.id === where.id);
        return Promise.resolve(found || null);
      }),
      update: jest.fn().mockImplementation(({ where, data }) => {
        const item = mockMenuItems.find((i) => i.id === where.id);
        return Promise.resolve({ ...item, ...data });
      }),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MenuService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<MenuService>(MenuService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getTodayMenu', () => {
    it('should return all menu items formatted with categories', async () => {
      const result = await service.getTodayMenu();

      expect(result.categories).toEqual([
        Category.HOT_MEAL,
        Category.COLD_DRINK,
        Category.SNACK,
      ]);
      expect(result.totalCount).toBe(2);
      expect(result.items[0].name).toBe('Grilled Teriyaki Chicken Bowl');
      expect(result.items[0].prepDurationMins).toBe(6);
      expect(result.items[0].pickupZone).toBe(PickupZone.SHELF_A);
      expect(result.items[0].modifiersSchema).toHaveLength(1);
    });

    it('should filter items by category when requested', async () => {
      const result = await service.getTodayMenu({
        category: Category.COLD_DRINK,
      });

      expect(result.totalCount).toBe(1);
      expect(result.items[0].name).toBe('Artisan Iced Latte');
      expect(result.items[0].isAvailable).toBe(false);
    });
  });

  describe('toggleItemStock', () => {
    it('should update item availability to false (sold out / 86)', async () => {
      const updated = await service.toggleItemStock('item-uuid-1', false);
      expect(updated.isAvailable).toBe(false);
    });

    it('should throw NotFoundException if item does not exist', async () => {
      await expect(
        service.toggleItemStock('non-existent-id', false),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
