import { Injectable, Logger } from '@nestjs/common';
import {
  GROWW_EXCHANGES,
  GROWW_ORDER_TYPES,
  GROWW_PRODUCTS,
  GROWW_SEGMENTS,
  GROWW_TRANSACTION_TYPES,
  GROWW_VALIDITIES,
} from '../../config/groww';
import { GrowwClientService } from '../groww/groww-client.service';
import { InstrumentCacheService } from '../groww/instrument-cache.service';
import { MarketCalendarService } from '../market-calendar.service';
import {
  ProposedOrderIntent,
  TradePolicy,
  ValidationResult,
} from '../trade-agent.types';

/**
 * Structural validation of a proposed order. Runs before the risk engine.
 *
 * Entirely deterministic — no model is consulted about whether a proposal is
 * well-formed. Everything here is a fact check against the instrument master,
 * the policy, and the session calendar.
 *
 * A rejected intent is always stored with its reasons; it is never silently
 * dropped, because "the model proposed nothing" and "we threw its proposal
 * away" must stay distinguishable.
 */
@Injectable()
export class OrderIntentValidatorService {
  private readonly logger = new Logger(OrderIntentValidatorService.name);

  constructor(
    private readonly instruments: InstrumentCacheService,
    private readonly calendar: MarketCalendarService,
    private readonly groww: GrowwClientService,
  ) {}

  async validate(
    intent: ProposedOrderIntent,
    policy: TradePolicy,
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    const tradingSymbol = String(intent.tradingSymbol || '')
      .trim()
      .toUpperCase();
    const exchange = intent.exchange;
    const segment = intent.segment;

    if (!tradingSymbol) errors.push('Trading symbol is empty.');
    if (!GROWW_EXCHANGES.includes(exchange)) {
      errors.push(`Unsupported exchange: ${intent.exchange}.`);
    }
    if (!GROWW_SEGMENTS.includes(segment)) {
      errors.push(
        `Unsupported segment: ${intent.segment}. Groww's API covers CASH and FNO only.`,
      );
    }
    if (!GROWW_TRANSACTION_TYPES.includes(intent.transactionType)) {
      errors.push(`Unsupported transaction type: ${intent.transactionType}.`);
    }
    if (!GROWW_ORDER_TYPES.includes(intent.orderType)) {
      errors.push(`Unsupported order type: ${intent.orderType}.`);
    }
    if (!GROWW_PRODUCTS.includes(intent.product)) {
      errors.push(`Unsupported product: ${intent.product}.`);
    }
    if (!GROWW_VALIDITIES.includes(intent.validity)) {
      errors.push(`Unsupported validity: ${intent.validity}.`);
    }

    // Policy: segment must be explicitly enabled by the operator.
    if (!policy.allowedSegments.includes(segment)) {
      errors.push(
        `Segment ${segment} is not enabled in the trade policy (allowed: ${
          policy.allowedSegments.join(', ') || 'none'
        }).`,
      );
    }

    // Instrument must resolve exactly. No fuzzy matching, ever.
    const instrument = tradingSymbol
      ? this.instruments.resolve(exchange, segment, tradingSymbol)
      : null;

    if (!instrument) {
      if (!this.instruments.status().ready) {
        errors.push(
          'Instrument master has not loaded yet, so the symbol cannot be verified.',
        );
      } else {
        errors.push(
          `Unknown instrument: ${exchange}/${segment}/${tradingSymbol} is not in the instrument master.`,
        );
      }
    } else {
      if (intent.transactionType === 'BUY' && !instrument.buyAllowed) {
        errors.push(`${tradingSymbol} is not currently buy-allowed.`);
      }
      if (intent.transactionType === 'SELL' && !instrument.sellAllowed) {
        errors.push(`${tradingSymbol} is not currently sell-allowed.`);
      }

      if (instrument.expiryDate) {
        const today = this.calendar.istDateKey();
        if (instrument.expiryDate < today) {
          errors.push(
            `${tradingSymbol} expired on ${instrument.expiryDate}; today is ${today}.`,
          );
        }
      }
    }

    // Quantity: positive integer, and a whole lot multiple where lots apply.
    const quantity = Number(intent.quantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      errors.push(
        `Quantity must be a positive whole number, got ${intent.quantity}.`,
      );
    } else if (instrument && instrument.lotSize > 1) {
      if (quantity % instrument.lotSize !== 0) {
        errors.push(
          `Quantity ${quantity} is not a multiple of the ${instrument.lotSize} lot size for ${tradingSymbol}.`,
        );
      }
      if (instrument.freezeQuantity && quantity > instrument.freezeQuantity) {
        errors.push(
          `Quantity ${quantity} exceeds the exchange freeze quantity of ${instrument.freezeQuantity}.`,
        );
      }
    }

    // Price and trigger requirements follow the order type.
    const price = Number(intent.price ?? 0);
    const triggerPrice = Number(intent.triggerPrice ?? 0);

    if (['LIMIT', 'SL'].includes(intent.orderType) && !(price > 0)) {
      errors.push(`${intent.orderType} orders require a positive price.`);
    }
    if (['SL', 'SL_M'].includes(intent.orderType) && !(triggerPrice > 0)) {
      errors.push(
        `${intent.orderType} orders require a positive trigger price.`,
      );
    }
    if (intent.orderType === 'MARKET' && price > 0) {
      errors.push('MARKET orders must not carry a price.');
    }

    if (instrument && instrument.tickSize > 0 && price > 0) {
      const ticks = price / instrument.tickSize;
      if (Math.abs(ticks - Math.round(ticks)) > 1e-6) {
        errors.push(
          `Price ${price} is not a multiple of the ${instrument.tickSize} tick size.`,
        );
      }
    }

    // Session: never queue an order into a closed market.
    const session = this.calendar.describe();
    if (!session.marketOpen) {
      errors.push(
        `Market is not open (${session.phase}, IST date ${session.istDate}).`,
      );
    }

    // Reference price for notional, and circuit limits when the broker gives them.
    let referencePrice = price;
    let circuitChecked = false;

    if (errors.length === 0) {
      try {
        const quote = await this.groww.getQuote({
          exchange,
          segment,
          tradingSymbol,
        });

        const lastPrice = Number(
          quote?.last_price ?? quote?.ltp ?? quote?.close ?? 0,
        );
        if (!(referencePrice > 0) && lastPrice > 0) referencePrice = lastPrice;

        const upper = Number(
          quote?.upper_circuit_limit ?? quote?.upper_circuit ?? 0,
        );
        const lower = Number(
          quote?.lower_circuit_limit ?? quote?.lower_circuit ?? 0,
        );

        if (price > 0 && upper > 0 && lower > 0) {
          circuitChecked = true;
          if (price > upper || price < lower) {
            errors.push(
              `Price ${price} is outside the circuit band ${lower}–${upper}.`,
            );
          }
        }
      } catch (error) {
        // A quote failure is not itself a validation failure — but we must not
        // then pretend the circuit check happened.
        this.logger.warn(
          `Could not fetch a quote for ${tradingSymbol}: ${(error as Error).message}`,
        );
      }
    }

    if (errors.length > 0) {
      return { valid: false, errors };
    }

    if (!(referencePrice > 0)) {
      return {
        valid: false,
        errors: [
          `No usable reference price for ${tradingSymbol}, so the order value cannot be checked.`,
        ],
      };
    }

    if (!circuitChecked && price > 0) {
      this.logger.warn(
        `Circuit limits unavailable for ${tradingSymbol}; the band check was skipped.`,
      );
    }

    return {
      valid: true,
      errors: [],
      normalised: {
        ...intent,
        tradingSymbol,
        quantity,
        price: price || 0,
        triggerPrice: triggerPrice || 0,
        notional: Number((referencePrice * quantity).toFixed(2)),
      },
    };
  }
}
