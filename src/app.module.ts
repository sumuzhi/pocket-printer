import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'

import { PrinterModule } from './printer/printer.module.ts'
import { RootController } from './root.controller.ts'
import { loadConfig } from './config/configuration.ts'

@Module({
  imports: [
    // `isGlobal` so any provider can inject ConfigService without re-importing.
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig], cache: true }),
    PrinterModule,
  ],
  controllers: [RootController],
})
export class AppModule {}
