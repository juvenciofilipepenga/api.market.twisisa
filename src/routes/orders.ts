import type { FastifyInstance } from "fastify";
import { OrderStatus, Prisma } from "../generated/prisma/client.js";
import { z } from "zod";
import { env } from "../config/env.js";
import { prisma } from "../lib/prisma.js";
import { randomReference } from "../lib/auth.js";
import { requireAuth, isAdmin } from "../middleware/auth.js";
import { audit } from "../services/audit.js";
import { notifyAdmins, notifyUser } from "../services/notifications.js";

const createOrderSchema = z.object({
  // Envio e desconto NÃO vêm do cliente: são calculados no servidor.
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(100)
      })
    )
    .min(1)
    .max(100)
});

const cancellable = new Set<OrderStatus>([
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAYMENT_REVIEW,
  OrderStatus.PAID
]);

// Estados que um admin pode atribuir manualmente e os estados a partir dos quais cada um é alcançável.
const adminTransitions: Record<string, OrderStatus[]> = {
  [OrderStatus.PROCESSING]: [OrderStatus.PAID],
  [OrderStatus.READY_FOR_SHIPMENT]: [OrderStatus.PROCESSING],
  [OrderStatus.SHIPPED]: [OrderStatus.READY_FOR_SHIPMENT],
  [OrderStatus.OUT_FOR_DELIVERY]: [OrderStatus.SHIPPED],
  [OrderStatus.DELIVERED]: [
    OrderStatus.OUT_FOR_DELIVERY,
    OrderStatus.SHIPPED
  ],
  [OrderStatus.CANCELLATION_REQUESTED]: [
    OrderStatus.PENDING_PAYMENT,
    OrderStatus.PAYMENT_REVIEW,
    OrderStatus.PAID,
    OrderStatus.PROCESSING
  ],
  [OrderStatus.CANCELLED]: [OrderStatus.CANCELLATION_REQUESTED],
  [OrderStatus.REFUND_PENDING]: [
    OrderStatus.CANCELLED,
    OrderStatus.CANCELLATION_REQUESTED
  ],
  [OrderStatus.REFUNDED]: [OrderStatus.REFUND_PENDING]
};

// O stock volta uma única vez: ao cancelar (CANCELLED) ou, se nunca passou por CANCELLED, ao reembolsar.
const restockOnTransition = new Set<OrderStatus>([
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED
]);

export async function orderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/orders", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ error: "INVALID_INPUT" });
    }

    try {
      const order = await prisma.$transaction(async (tx) => {
        const requestedItems = parsed.data.items;
        const ids = [
          ...new Set(requestedItems.map((item) => item.productId))
        ];

        const products = await tx.product.findMany({
          where: {
            id: { in: ids },
            active: true
          },
          include: {
            variants: {
              where: {
                active: true
              }
            }
          }
        });

        const productMap = new Map(
          products.map((product) => [product.id, product])
        );

        if (products.length !== ids.length) {
          throw new Error("PRODUCT_NOT_FOUND");
        }

        let subtotal = new Prisma.Decimal(0);

        const items: Array<{
          productId: string;
          variantId?: string;
          variantColorHex?: string;
          variantSize?: string;
          productName: string;
          unitPriceMzn: Prisma.Decimal;
          quantity: number;
          subtotalMzn: Prisma.Decimal;
        }> = [];

        for (const requested of requestedItems) {
          const product = productMap.get(requested.productId)!;

          const variant = requested.variantId
            ? product.variants.find(
                (candidate) => candidate.id === requested.variantId
              )
            : undefined;

          if (product.variants.length > 0 && !variant) {
            throw new Error("VARIANT_REQUIRED");
          }

          const availableStock = variant
            ? variant.stock
            : product.stock;

          if (availableStock < requested.quantity) {
            throw new Error("INSUFFICIENT_STOCK");
          }

          const line = product.priceMzn.mul(requested.quantity);
          subtotal = subtotal.add(line);

          items.push({
            productId: product.id,
            variantId: variant?.id,
            variantColorHex: variant?.colorHex ?? undefined,
            variantSize: variant?.size ?? undefined,
            productName: product.name,
            unitPriceMzn: product.priceMzn,
            quantity: requested.quantity,
            subtotalMzn: line
          });

          if (variant) {
            const changed = await tx.productVariant.updateMany({
              where: {
                id: variant.id,
                stock: {
                  gte: requested.quantity
                },
                active: true
              },
              data: {
                stock: {
                  decrement: requested.quantity
                }
              }
            });

            if (changed.count === 0) {
              throw new Error("INSUFFICIENT_STOCK");
            }

            await tx.product.update({
              where: {
                id: product.id
              },
              data: {
                stock: {
                  decrement: requested.quantity
                }
              }
            });
          } else {
            const changed = await tx.product.updateMany({
              where: {
                id: product.id,
                stock: {
                  gte: requested.quantity
                }
              },
              data: {
                stock: {
                  decrement: requested.quantity
                }
              }
            });

            if (changed.count === 0) {
              throw new Error("INSUFFICIENT_STOCK");
            }
          }
        }

        const shipping = new Prisma.Decimal(env.SHIPPING_FLAT_MZN);

        // Sem cupões ainda; só o servidor pode aplicar descontos.
        const discount = new Prisma.Decimal(0);

        const total = subtotal.add(shipping).sub(discount);

        if (total.isNegative()) {
          throw new Error("INVALID_TOTAL");
        }

        return tx.order.create({
          data: {
            orderNumber: randomReference("TW-ORD"),
            userId: request.auth!.userId,
            subtotalMzn: subtotal,
            shippingMzn: shipping,
            discountMzn: discount,
            totalMzn: total,
            items: {
              create: items
            },
            statusHistory: {
              create: {
                to: OrderStatus.PENDING_PAYMENT,
                reason: "Order created",
                actorId: request.auth!.userId
              }
            }
          },
          include: {
            items: true
          }
        });
      });

      // A encomenda já está confirmada e o stock já foi descontado;
      // uma falha aqui não pode devolver 500.
      try {
        await audit({
          actorId: request.auth!.userId,
          action: "ORDER_CREATED",
          entity: "Order",
          entityId: order.id,
          ip: request.ip,
          userAgent: request.headers["user-agent"]
        });

        await notifyUser({
          userId: request.auth!.userId,
          type: "ORDER",
          title: "Encomenda criada",
          message: `A encomenda ${order.orderNumber} foi criada.`,
          data: {
            orderId: order.id
          }
        });

        await notifyAdmins({
          type: "ORDER",
          title: "Nova encomenda",
          message: `Nova encomenda ${order.orderNumber}.`,
          data: {
            orderId: order.id
          }
        });
      } catch (error) {
        request.log.error(
          error,
          "order side effects failed"
        );
      }

      return reply.code(201).send(order);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "ORDER_CREATE_FAILED";

      const map: Record<string, number> = {
        PRODUCT_NOT_FOUND: 404,
        VARIANT_REQUIRED: 400,
        INSUFFICIENT_STOCK: 409,
        INVALID_TOTAL: 400
      };

      return reply
        .code(map[message] ?? 500)
        .send({
          error: map[message]
            ? message
            : "ORDER_CREATE_FAILED"
        });
    }
  });

  app.get(
    "/orders/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = z
        .object({
          id: z.string().min(1)
        })
        .safeParse(request.params);

      if (!parsed.success) {
        return reply.code(400).send({
          error: "INVALID_INPUT"
        });
      }

      const order = await prisma.order.findUnique({
        where: {
          id: parsed.data.id
        },
        include: {
          items: true,
          payments: true,
          statusHistory: {
            orderBy: {
              createdAt: "asc"
            }
          },
          invoice: true
        }
      });

      if (!order) {
        return reply.code(404).send({
          error: "ORDER_NOT_FOUND"
        });
      }

      if (
        order.userId !== request.auth!.userId &&
        !isAdmin(request.auth!.roles)
      ) {
        return reply.code(403).send({
          error: "FORBIDDEN"
        });
      }

      if (isAdmin(request.auth!.roles)) return order;

      // Mesma regra de GET /payments/:id: sem códigos/mensagens de falha nem ids internos do gateway.
      return {
        ...order,
        payments: order.payments.map((payment) => ({
          ...payment,
          transactionCode: null,
          providerPaymentId: null,
          failureCode: undefined,
          failureMessage: undefined
        }))
      };
    }
  );

  app.post(
    "/orders/:id/cancel",
    { preHandler: requireAuth },
    async (request, reply) => {
      const params = z
        .object({
          id: z.string().min(1)
        })
        .safeParse(request.params);

      const body = z
        .object({
          reason: z.string().trim().min(3).max(500)
        })
        .safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: "INVALID_INPUT"
        });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: {
              id: params.data.id
            },
            include: {
              items: true
            }
          });

          if (!order) {
            throw new Error("ORDER_NOT_FOUND");
          }

          if (
            order.userId !== request.auth!.userId &&
            !isAdmin(request.auth!.roles)
          ) {
            throw new Error("FORBIDDEN");
          }

          if (!cancellable.has(order.status)) {
            throw new Error("ORDER_NOT_CANCELLABLE");
          }

          // Transição condicional ao estado lido.
          const claimed = await tx.order.updateMany({
            where: {
              id: order.id,
              status: order.status
            },
            data: {
              status: OrderStatus.CANCELLED,
              cancellationReason: body.data.reason,
              cancelledAt: new Date(),
              cancelledById: request.auth!.userId
            }
          });

          if (claimed.count === 0) {
            throw new Error("ORDER_NOT_CANCELLABLE");
          }

          for (const item of order.items) {
            // Produto apagado depois da encomenda: não há stock a repor.
            if (!item.productId) continue;
            if (item.variantId) {
              await tx.productVariant.update({
                where: {
                  id: item.variantId
                },
                data: {
                  stock: {
                    increment: item.quantity
                  }
                }
              });

              await tx.product.update({
                where: {
                  id: item.productId
                },
                data: {
                  stock: {
                    increment: item.quantity
                  }
                }
              });
            } else {
              await tx.product.update({
                where: {
                  id: item.productId
                },
                data: {
                  stock: {
                    increment: item.quantity
                  }
                }
              });
            }
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              from: order.status,
              to: OrderStatus.CANCELLED,
              reason: body.data.reason,
              actorId: request.auth!.userId
            }
          });

          const updated = await tx.order.findUniqueOrThrow({
            where: {
              id: order.id
            }
          });

          return {
            updated,
            userId: order.userId
          };
        });

        try {
          await audit({
            actorId: request.auth!.userId,
            action: "ORDER_CANCELLED",
            entity: "Order",
            entityId: result.updated.id,
            metadata: {
              reason: body.data.reason
            }
          });

          await notifyUser({
            userId: result.userId,
            type: "ORDER",
            title: "Encomenda cancelada",
            message: `A encomenda ${result.updated.orderNumber} foi cancelada.`,
            data: {
              orderId: result.updated.id
            }
          });

          await notifyAdmins({
            type: "ORDER",
            title: "Encomenda cancelada",
            message: `A encomenda ${result.updated.orderNumber} foi cancelada.`,
            data: {
              orderId: result.updated.id
            }
          });
        } catch (error) {
          request.log.error(
            error,
            "cancel side effects failed"
          );
        }

        return result.updated;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "CANCEL_FAILED";

        const map: Record<string, number> = {
          ORDER_NOT_FOUND: 404,
          FORBIDDEN: 403,
          ORDER_NOT_CANCELLABLE: 409
        };

        return reply
          .code(map[message] ?? 500)
          .send({
            error: map[message]
              ? message
              : "CANCEL_FAILED"
          });
      }
    }
  );

  // Avança o estado da encomenda numa transição admitida;
  // devolve o stock quando a encomenda é reembolsada.
  app.post(
    "/admin/orders/:id/status",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isAdmin(request.auth!.roles)) {
        return reply.code(403).send({
          error: "FORBIDDEN"
        });
      }

      const params = z
        .object({
          id: z.string().min(1)
        })
        .safeParse(request.params);

      const body = z
        .object({
          status: z.nativeEnum(OrderStatus),
          reason: z.string().trim().max(500).optional()
        })
        .safeParse(request.body);

      if (!params.success || !body.success) {
        return reply.code(400).send({
          error: "INVALID_INPUT"
        });
      }

      const allowedFrom =
        adminTransitions[body.data.status];

      if (!allowedFrom) {
        return reply.code(400).send({
          error: "STATUS_NOT_MANUALLY_ASSIGNABLE"
        });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: {
              id: params.data.id
            },
            include: {
              items: true
            }
          });

          if (!order) {
            throw new Error("ORDER_NOT_FOUND");
          }

          if (!allowedFrom.includes(order.status)) {
            throw new Error("INVALID_TRANSITION");
          }

          const claimed = await tx.order.updateMany({
            where: {
              id: order.id,
              status: order.status
            },
            data: {
              status: body.data.status,
              ...(body.data.status === OrderStatus.CANCELLED
                ? {
                    cancelledAt: new Date(),
                    cancelledById: request.auth!.userId,
                    cancellationReason: body.data.reason
                  }
                : {})
            }
          });

          if (claimed.count === 0) {
            throw new Error("INVALID_TRANSITION");
          }

          // CANCELLED -> REFUND_PENDING -> REFUNDED repunha o stock duas vezes (já tinha sido reposto no cancelamento).
          const alreadyRestocked =
            (await tx.orderStatusHistory.count({
              where: { orderId: order.id, to: OrderStatus.CANCELLED }
            })) > 0;

          if (restockOnTransition.has(body.data.status) && !alreadyRestocked) {
            for (const item of order.items) {
            // Produto apagado depois da encomenda: não há stock a repor.
            if (!item.productId) continue;
              if (item.variantId) {
                await tx.productVariant.update({
                  where: {
                    id: item.variantId
                  },
                  data: {
                    stock: {
                      increment: item.quantity
                    }
                  }
                });

                await tx.product.update({
                  where: {
                    id: item.productId
                  },
                  data: {
                    stock: {
                      increment: item.quantity
                    }
                  }
                });
              } else {
                await tx.product.update({
                  where: {
                    id: item.productId
                  },
                  data: {
                    stock: {
                      increment: item.quantity
                    }
                  }
                });
              }
            }
          }

          await tx.orderStatusHistory.create({
            data: {
              orderId: order.id,
              from: order.status,
              to: body.data.status,
              reason: body.data.reason,
              actorId: request.auth!.userId
            }
          });

          return {
            updated: await tx.order.findUniqueOrThrow({
              where: {
                id: order.id
              }
            }),
            userId: order.userId
          };
        });

        try {
          await audit({
            actorId: request.auth!.userId,
            action: "ORDER_STATUS_CHANGED",
            entity: "Order",
            entityId: result.updated.id,
            metadata: {
              status: body.data.status,
              reason: body.data.reason
            }
          });

          await notifyUser({
            userId: result.userId,
            type: "ORDER",
            title: "Encomenda atualizada",
            message: `A encomenda ${result.updated.orderNumber} está agora ${body.data.status}.`,
            data: {
              orderId: result.updated.id,
              status: body.data.status
            }
          });
        } catch (error) {
          request.log.error(
            error,
            "order status side effects failed"
          );
        }

        return result.updated;
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "STATUS_UPDATE_FAILED";

        return reply
          .code(
            message === "ORDER_NOT_FOUND"
              ? 404
              : message === "INVALID_TRANSITION"
                ? 409
                : 500
          )
          .send({
            error: message
          });
      }
    }
  );

  app.get(
    "/admin/orders",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isAdmin(request.auth!.roles)) {
        return reply.code(403).send({
          error: "FORBIDDEN"
        });
      }

      const q = z
        .object({
          status: z.nativeEnum(OrderStatus).optional(),
          page: z.coerce.number().int().min(1).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(20)
        })
        .parse(request.query);

      const where = q.status
        ? { status: q.status }
        : {};

      const [data, total] = await Promise.all([
        prisma.order.findMany({
          where,
          skip: (q.page - 1) * q.limit,
          take: q.limit,
          orderBy: {
            createdAt: "desc"
          },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true
              }
            },
            items: true,
            payments: true,
            invoice: true
          }
        }),
        prisma.order.count({
          where
        })
      ]);

      return {
        data,
        pagination: {
          page: q.page,
          limit: q.limit,
          total
        }
      };
    }
  );
}
