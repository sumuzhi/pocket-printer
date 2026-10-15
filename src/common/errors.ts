/**
 * Domain errors, so services can signal intent without importing HTTP concepts.
 *
 * A global exception filter maps these to status codes in one place
 * (see `DomainExceptionFilter`), which keeps services free of `@nestjs/common`
 * HTTP types and makes the mapping reviewable.
 */

export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** The caller sent something the service cannot print. */
export class BadInputError extends DomainError {
  constructor(message: string) {
    super(message, 400)
  }
}

/** The payload is larger than the printer accepts. */
export class PayloadTooLargeError extends DomainError {
  constructor(message: string) {
    super(message, 413)
  }
}

/** The printer is busy with another job. */
export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 409)
  }
}

/** The printer could not be reached, or refused the request. */
export class PrinterUnavailableError extends DomainError {
  constructor(message: string) {
    super(message, 503)
  }
}
