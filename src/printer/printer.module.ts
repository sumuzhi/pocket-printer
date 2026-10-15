/** Wires the printer-related services and controllers together. */
import { Module } from '@nestjs/common'

import { PrinterService } from './printer.service.ts'
import { PrinterController } from './printer.controller.ts'
import { StagingService } from './staging.service.ts'
import { StagingController } from './staging.controller.ts'

@Module({
  controllers: [PrinterController, StagingController],
  providers: [PrinterService, StagingService],
  exports: [PrinterService, StagingService],
})
export class PrinterModule {}
