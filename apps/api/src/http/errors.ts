import { Catch, type ExceptionFilter, type ArgumentsHost, HttpException } from "@nestjs/common";
import { ZodError } from "zod";
import { AppError } from "@tienda/shared";
@Catch()
export class Errors implements ExceptionFilter {
  catch(e: any, host: ArgumentsHost) {
    let status = 500,
      code = "internal_error",
      message = "No se pudo completar la operación.";
    if (e instanceof AppError) {
      status = e.status;
      code = e.code;
      message = e.message;
    } else if (e instanceof ZodError) {
      status = 400;
      code = "validation_error";
      message = e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(" · ");
    } else if (e instanceof HttpException) {
      status = e.getStatus();
      code = "request_error";
      message = e.message;
    } else if (e?.code === "23505") {
      status = 409;
      code = "duplicate";
      message =
        e.constraint === "serial_records_number_unique"
          ? "Este número de serie ya está registrado."
          : "Ya existe un registro con esa referencia o SKU.";
    } else if (e?.code === "23503") {
      status = 409;
      code = "reference_error";
      message = "La referencia no existe o tiene movimientos vinculados.";
    } else if (e?.code === "23514") {
      status = 400;
      code = "invalid_value";
      message = "Los valores no cumplen las restricciones del registro.";
    } else if (e?.code === "22003") {
      status = 400;
      code = "amount_too_large";
      message = "El importe o la cantidad exceden el límite permitido.";
    } else console.error("API error", e?.code ?? "", e?.message ?? "");
    host.switchToHttp().getResponse().status(status).json({ code, message });
  }
}
