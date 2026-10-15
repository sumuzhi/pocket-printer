var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
/** Wires the printer-related services and controllers together. */
import { Module } from '@nestjs/common';
import { PrinterService } from "./printer.service.js";
import { PrinterController } from "./printer.controller.js";
import { StagingService } from "./staging.service.js";
import { StagingController } from "./staging.controller.js";
let PrinterModule = class PrinterModule {
};
PrinterModule = __decorate([
    Module({
        controllers: [PrinterController, StagingController],
        providers: [PrinterService, StagingService],
        exports: [PrinterService, StagingService],
    })
], PrinterModule);
export { PrinterModule };
//# sourceMappingURL=printer.module.js.map