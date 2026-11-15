import { Module } from '@nestjs/common';
import { KdsController } from './kds.controller';
import { KdsService } from './kds.service';
import { MenuModule } from '../menu/menu.module';

@Module({
  imports: [MenuModule],
  controllers: [KdsController],
  providers: [KdsService],
  exports: [KdsService],
})
export class KdsModule {}
