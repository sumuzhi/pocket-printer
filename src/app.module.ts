import { Module } from '@nestjs/common'

import { PrinterModule } from './printer/printer.module.ts'
import { RootController } from './root.controller.ts'

@Module({
  imports: [PrinterModule],
  controllers: [RootController],
})
export class AppModule {}
