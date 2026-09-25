# Rithmic Protocol Notes (Milestone 9)

How Atlas speaks R | Protocol. **The official RProtocolAPI package is the authority;**
this file records how Atlas consumes it, not a substitute for it.

## Schema + template ids
- The protobuf schema is loaded once (`rithmic/protocol/registry.ts`) from the
  official `vendor/rithmic/proto/` when present, else the committed test double.
- Each message carries `template_id` (field 154467 by R | Protocol convention). The
  id ↔ message map is **derived from the schema's per-message `template_id`
  default** — Atlas never hardcodes an id. `rithmic:generate` binds the official
  values.

## Framing (`rithmic/protocol/framing.ts`)
- Each message is one binary WebSocket frame: `[4-byte big-endian uint32 length][protobuf body]`.
- `LENGTH_PREFIX_BYTES = 4` is the single knob; `MAX_FRAME_BYTES` guards a hostile
  length; `FrameStream` reassembles partial/coalesced chunks for a raw socket.
- Validated against the package samples at `rithmic:verify` time.

## Codec (`rithmic/protocol/codec.ts`)
- `encode(name, payload)` sets `template_id` from the registry, verifies and
  serializes, then frames.
- `decode(frame)` deframes, reads `template_id` with a schema-independent varint
  scan, looks up the message, and decodes. An unknown template routes to the
  unknown sink (never a throw); a malformed body is a structured `CodecError`.

## Router (`rithmic/protocol/router.ts`)
- Dispatches by message name, resolves request/response by echoed `user_msg`
  correlation, isolates a throwing handler, and counts routed/unknown/errors.

## Message set consumed by M9
Discovery (RequestRithmicSystemInfo/Response), login/logout/heartbeat, reference
data, market data (RequestMarketDataUpdate, LastTrade, BestBidOffer), history
(RequestTimeBarReplay/Response), account list, trade routes, order updates
subscription, new/modify/cancel order + responses, RithmicOrderNotification,
ExchangeOrderNotification, P&L (RequestPnLPositionUpdates, Instrument/Account
PnLPositionUpdate). Field/enum names match the documented R | Protocol names.
