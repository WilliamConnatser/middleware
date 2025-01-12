import Router from "@koa/router";
const router = new Router({
    prefix: "/v1/lnd/lightning"
});

import * as auth from "../../../middlewares/auth.js";
import { errorHandler, typeHelper } from "@runcitadel/utils";
import * as lightningLogic from "../../../logic/lightning.js";

router.use(errorHandler);

router.post(
    "/addInvoice",
    async (ctx, next) => {
        const amt = ctx.request.body.amt; // Denominated in Satoshi
        const memo = ctx.request.body.memo || "";

        typeHelper.isPositiveIntegerOrZero(amt, ctx as any);
        typeHelper.isValidMemoLength(memo, ctx as any);

        ctx.body = await lightningLogic
            .addInvoice(amt, memo);
        await next();
    }
);

router.get(
    "/forwardingEvents",
    auth.jwt,
    async (ctx, next) => {
        const startTime = <string>ctx.request.query.startTime;
        const endTime = <string>ctx.request.query.endTime;
        const indexOffset = <string>ctx.request.query.indexOffset;

        if (startTime) {
            typeHelper.isPositiveIntegerOrZero(startTime, ctx);
        }
        if (endTime) {
            typeHelper.isPositiveIntegerOrZero(endTime, ctx);
        }
        if (indexOffset) {
            typeHelper.isPositiveIntegerOrZero(indexOffset, ctx);
        }

        ctx.body = await lightningLogic
            .getForwardingEvents(parseInt(startTime), parseInt(endTime), parseInt(indexOffset));
        await next();
    }
);

router.get(
    "/invoice",
    auth.jwt,
    async (ctx, next) => {
        const paymentRequest = <string>ctx.request.query.paymentRequest;

        typeHelper.isAlphanumeric(paymentRequest, ctx);

        ctx.body = await lightningLogic
            .decodePaymentRequest(paymentRequest);
        await next();
    }
);

router.get(
    "/invoice-info",
    auth.jwt,
    async (ctx, next) => {
        const paymentHash = <string>ctx.request.query.paymentHash;

        ctx.body = await lightningLogic.getInvoice(paymentHash);
        await next();
    }
);

router.get(
    "/invoices",
    auth.jwt,
    async (ctx, next) => {
        ctx.body = await lightningLogic
            .getInvoices();
        await next();
    }
);

router.post(
    "/payInvoice",
    auth.jwt,
    async (ctx, next) => {
        const paymentRequest = ctx.request.body.paymentRequest;
        const amt = ctx.request.body.amt;

        typeHelper.isAlphanumeric(paymentRequest, ctx);

        if (amt) {
            typeHelper.isPositiveIntegerOrZero(amt, ctx);
        }

        const data = await lightningLogic
            .payInvoice(paymentRequest, amt);
        ctx.body = {
            ...data,
            paymentPreimage: Buffer.from(data.paymentPreimage).toString("base64"),
            paymentHash: Buffer.from(data.paymentHash).toString("base64"),
        }
        await next();
    }
);

router.get(
    "/payments",
    auth.jwt,
    async (ctx, next) => {
        ctx.body = await lightningLogic.getPayments();
        await next();
    }
);

export default router;
