import { deleteRow, getById, insertRow, uid, updateRow } from "../db/sql";
import { badRequest, httpError } from "../http/errors";
import { serializeList, serializeRow } from "../http/serialize";
import type { Router } from "../http/router";
import type { Ctx } from "../http/types";
import { utcnowIso } from "../core/timeutil";
import { requireManager } from "../core/auth";
import { Validator, bodyObject, getKey, intQuery, jsonField, money, pyFloat, pyInt, pyStr } from "./partiesCommon";

const DEFAULT_COMMISSION = 0.01;

/** 0 is a legitimate commission rate; only a missing value falls back to the default. */
const rate = (v: number | null | undefined) => (v == null ? DEFAULT_COMMISSION : Number(v));

export function registerEmployees(router: Router): void {
  // ---- Attendance (declared before the parameterised /employees/{employee_id} routes)
  router.get("/employees/attendance", (ctx) => {
    const empId = ctx.query.employee_id || ctx.query.employeeId;
    const date = ctx.query.date;
    const limit = intQuery(ctx, "limit", 500, 1, 5000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (empId) { where.push("employeeId=?"); args.push(empId); }
    if (date) { where.push("date=?"); args.push(date); }
    const sql = `SELECT * FROM employee_attendance${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY checkIn DESC, createdAt DESC LIMIT ?`;
    return serializeList(ctx.db.all(sql, [...args, limit]));
  });

  router.post("/employees/attendance", (ctx) => {
    const data = bodyObject(ctx);
    const now = utcnowIso(ctx.now());
    const empId = data.employeeId || data.employee_id;
    if (!empId) throw badRequest("معرف الموظف مطلوب", "VALIDATION_ERROR");
    if (data.id) {
      const found = getById(ctx.db, "employee_attendance", String(data.id));
      if (found) return serializeRow(found);
    }
    const id = data.id || uid();
    insertRow(ctx.db, "employee_attendance", {
      id,
      employeeId: empId,
      employeeName: data.employeeName || data.employee_name || null,
      employeeCode: data.employeeCode || getKey(data, "employee_code", ""),
      date: data.date || now.slice(0, 10),
      shiftId: data.shiftId || getKey(data, "shift_id", ""),
      checkIn: data.checkIn || data.check_in || now,
      checkOut: data.checkOut || data.check_out || null,
      durationMinutes: Math.max(0, pyInt(data.durationMinutes || data.duration_minutes || 0)),
      status: getKey(data, "status", "attended"),
      notes: getKey(data, "notes", ""),
      createdAt: now,
      updatedAt: now,
    });
    return serializeRow(getById(ctx.db, "employee_attendance", String(id)));
  });

  router.put("/employees/attendance/{att_id}", (ctx) => {
    const att = getById(ctx.db, "employee_attendance", ctx.params.att_id!);
    if (!att) throw httpError(404, "سجل الحضور غير موجود");
    const data = bodyObject(ctx);
    const patch: Record<string, unknown> = {};
    if ("checkOut" in data || "check_out" in data) patch.checkOut = data.checkOut || data.check_out || null;
    if ("durationMinutes" in data || "duration_minutes" in data) {
      patch.durationMinutes = Math.max(0, pyInt(data.durationMinutes || data.duration_minutes || 0));
    }
    if ("status" in data) patch.status = data.status;
    if ("notes" in data) patch.notes = data.notes;
    patch.updatedAt = utcnowIso(ctx.now());
    updateRow(ctx.db, "employee_attendance", att.id, patch);
    return serializeRow(getById(ctx.db, "employee_attendance", att.id));
  });

  router.delete("/employees/attendance/{att_id}", (ctx) => {
    requireManager(ctx);
    const att = getById(ctx.db, "employee_attendance", ctx.params.att_id!);
    if (att) deleteRow(ctx.db, "employee_attendance", att.id);
    return { success: true, message: "تم حذف سجل الحضور" };
  });

  // ---- Employee transactions
  router.get("/employees/transactions", (ctx) => {
    const empId = ctx.query.employee_id || ctx.query.employeeId;
    const month = ctx.query.month;
    const limit = intQuery(ctx, "limit", 1000, 1, 10000);
    const where: string[] = [];
    const args: unknown[] = [];
    if (empId) { where.push("employeeId=?"); args.push(empId); }
    if (month) { where.push("(month=? OR monthStr=?)"); args.push(month, month); }
    const sql = `SELECT * FROM employee_transactions${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY date DESC, createdAt DESC LIMIT ?`;
    return serializeList(ctx.db.all(sql, [...args, limit]));
  });

  router.post("/employees/transactions", (ctx) => {
    const data = bodyObject(ctx);
    const now = utcnowIso(ctx.now());
    const month = data.month || data.monthStr || now.slice(0, 7);
    const amount = money(data.amount || 0.0);
    if (amount <= 0) throw badRequest("المبلغ يجب أن يكون أكبر من صفر", "INVALID_AMOUNT");
    const empId = data.employeeId || data.employee_id;
    if (!empId || !getById(ctx.db, "employees", String(empId))) throw badRequest("الموظف غير موجود", "EMPLOYEE_NOT_FOUND");
    if (data.id) {
      const found = getById(ctx.db, "employee_transactions", String(data.id));
      if (found) return serializeRow(found);
    }
    const id = data.id || uid();
    insertRow(ctx.db, "employee_transactions", {
      id,
      employeeId: empId,
      employeeName: data.employeeName || data.employee_name || null,
      type: getKey(data, "type", "advance"),
      amount,
      date: data.date || now.slice(0, 10),
      month,
      monthStr: month,
      invoiceNumber: getKey(data, "invoiceNumber", ""),
      createdByUser: jsonField(data.createdByUser),
      createdBy: jsonField(data.createdBy),
      notes: getKey(data, "notes", ""),
      createdAt: now,
    });
    return serializeRow(getById(ctx.db, "employee_transactions", String(id)));
  });

  router.delete("/employees/transactions/{tx_id}", (ctx) => {
    requireManager(ctx);
    const tx = getById(ctx.db, "employee_transactions", ctx.params.tx_id!);
    if (tx) deleteRow(ctx.db, "employee_transactions", tx.id);
    return { success: true, message: "تم حذف العملية" };
  });

  // ---- Employees master directory
  router.get("/employees", (ctx) => serializeList(ctx.db.all(`SELECT * FROM employees ORDER BY name ASC`)));

  router.post("/employees", (ctx) => {
    requireManager(ctx);
    const body = bodyObject(ctx);
    const v = new Validator(body);
    const name = v.str("name", { required: true, min: 1, max: 150 }) as string;
    const phone = v.str("phone"), role = v.str("role"), code = v.str("code"), status = v.str("status");
    const hireDate = v.str("hireDate"), joinDate = v.str("joinDate"), notes = v.str("notes");
    const baseSalary = v.num("baseSalary", { ge: 0 });
    const commissionRate = v.num("commissionRate", { ge: 0, le: 1 });
    v.done();

    const now = utcnowIso(ctx.now());
    const id = uid();
    insertRow(ctx.db, "employees", {
      id,
      name: name.trim(),
      phone: phone || "",
      role: role || "موظف مبيعات",
      code: code || "",
      baseSalary: money(baseSalary || 0.0),
      commissionRate: rate(commissionRate),
      status: status || "active",
      hireDate: hireDate || joinDate || "",
      joinDate: joinDate || hireDate || "",
      notes: notes || "",
      createdAt: now,
      updatedAt: now,
    });
    return serializeRow(getById(ctx.db, "employees", id));
  });

  const mustGet = (ctx: Ctx) => {
    const e = getById(ctx.db, "employees", ctx.params.employee_id!);
    if (!e) throw httpError(404, "الموظف غير موجود");
    return e;
  };

  router.get("/employees/{employee_id}", (ctx) => serializeRow(mustGet(ctx)));

  const update = (ctx: Ctx) => {
    requireManager(ctx);
    const emp = mustGet(ctx);
    const data = bodyObject(ctx);
    const patch: Record<string, unknown> = {};

    if (data.name != null) {
      const name = pyStr(data.name).trim();
      if (!name) throw badRequest("اسم الموظف مطلوب", "VALIDATION_ERROR");
      patch.name = name;
    }
    for (const f of ["phone", "role", "code", "status", "notes", "hireDate", "joinDate"]) {
      if (data[f] != null) patch[f] = pyStr(data[f]);
    }
    const salary = "baseSalary" in data ? data.baseSalary : data.base_salary;
    if (salary != null) {
      if (pyFloat(salary) < 0) throw badRequest("الراتب لا يمكن أن يكون سالباً", "VALIDATION_ERROR");
      patch.baseSalary = money(salary);
    }
    const cr = "commissionRate" in data ? data.commissionRate : data.commission_rate;
    if (cr != null) {
      const f = pyFloat(cr);
      if (!(f >= 0 && f <= 1)) throw badRequest("نسبة العمولة يجب أن تكون بين 0 و 1", "VALIDATION_ERROR");
      patch.commissionRate = f;
    }

    patch.updatedAt = utcnowIso(ctx.now());
    updateRow(ctx.db, "employees", emp.id, patch);
    return serializeRow(getById(ctx.db, "employees", emp.id));
  };
  router.put("/employees/{employee_id}", update);
  router.patch("/employees/{employee_id}", update);

  router.delete("/employees/{employee_id}", (ctx) => {
    requireManager(ctx);
    const emp = mustGet(ctx);
    deleteRow(ctx.db, "employees", emp.id);
    return { success: true, message: "تم حذف الموظف" };
  });
}
