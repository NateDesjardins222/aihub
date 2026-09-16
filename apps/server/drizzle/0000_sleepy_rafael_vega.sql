CREATE TABLE "account_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"type" varchar(40) NOT NULL,
	"user_id" uuid,
	"source" varchar(10) NOT NULL,
	"request" jsonb,
	"prev_state" jsonb,
	"new_state" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_template_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'ACTIVE' NOT NULL,
	"starting_balance_micros" bigint NOT NULL,
	"balance_micros" bigint NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	"fees_micros" bigint DEFAULT 0 NOT NULL,
	"high_water_mark_micros" bigint NOT NULL,
	"drawdown_floor_micros" bigint NOT NULL,
	"trading_days_count" integer DEFAULT 0 NOT NULL,
	"current_trade_date" date,
	"day_start_balance_micros" bigint NOT NULL,
	"day_start_equity_micros" bigint NOT NULL,
	"seq" bigint DEFAULT 0 NOT NULL,
	"failed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_indicators" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"layout_id" uuid NOT NULL,
	"chart_id" varchar(64) NOT NULL,
	"type" varchar(48) NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pane" integer DEFAULT 0 NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chart_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layout_id" uuid NOT NULL,
	"chart_id" varchar(64) NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"timeframe" varchar(8) NOT NULL,
	"chart_type" varchar(24) DEFAULT 'CANDLES' NOT NULL,
	"link_group" varchar(16),
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_account_stats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"trade_date" date NOT NULL,
	"starting_balance_micros" bigint NOT NULL,
	"ending_balance_micros" bigint NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	"fees_micros" bigint DEFAULT 0 NOT NULL,
	"high_equity_micros" bigint NOT NULL,
	"low_equity_micros" bigint NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"counted" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drawings" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"layout_id" uuid NOT NULL,
	"chart_id" varchar(64) NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"tool" varchar(48) NOT NULL,
	"points" jsonb NOT NULL,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"z_index" integer DEFAULT 0 NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"timeframe_visibility" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"side" varchar(4) NOT NULL,
	"qty" integer NOT NULL,
	"price_ticks" integer NOT NULL,
	"fees_micros" bigint DEFAULT 0 NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	"slippage_ticks" integer DEFAULT 0 NOT NULL,
	"liquidity" varchar(8) DEFAULT 'TAKER' NOT NULL,
	"exec_time" timestamp with time zone NOT NULL,
	"seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historical_bars" (
	"symbol" varchar(12) NOT NULL,
	"timeframe" varchar(8) NOT NULL,
	"bar_time" bigint NOT NULL,
	"open_ticks" integer NOT NULL,
	"high_ticks" integer NOT NULL,
	"low_ticks" integer NOT NULL,
	"close_ticks" integer NOT NULL,
	"volume" bigint DEFAULT 0 NOT NULL,
	"provider" varchar(40) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "layouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"config" jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_data_meta" (
	"symbol" varchar(12) PRIMARY KEY NOT NULL,
	"provider" varchar(40) NOT NULL,
	"mode" varchar(12) NOT NULL,
	"delay_seconds" integer DEFAULT 0 NOT NULL,
	"last_event_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"depth_levels" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"client_order_id" varchar(128) NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"side" varchar(4) NOT NULL,
	"qty" integer NOT NULL,
	"filled_qty" integer DEFAULT 0 NOT NULL,
	"type" varchar(16) NOT NULL,
	"limit_ticks" integer,
	"stop_ticks" integer,
	"tif" varchar(4) DEFAULT 'DAY' NOT NULL,
	"status" varchar(20) NOT NULL,
	"avg_fill_ticks" real,
	"oco_group_id" uuid,
	"parent_order_id" uuid,
	"bracket_role" varchar(16) DEFAULT 'STANDALONE' NOT NULL,
	"trail_ticks" integer,
	"trail_anchor_ticks" integer,
	"reject_reason" varchar(40),
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"side" varchar(6) DEFAULT 'FLAT' NOT NULL,
	"qty" integer DEFAULT 0 NOT NULL,
	"avg_entry_ticks" real DEFAULT 0 NOT NULL,
	"realized_pnl_micros" bigint DEFAULT 0 NOT NULL,
	"fees_micros" bigint DEFAULT 0 NOT NULL,
	"opened_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by_token_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "risk_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"order_id" uuid,
	"rule" varchar(48) NOT NULL,
	"reason_code" varchar(40) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"account_size_micros" bigint NOT NULL,
	"profit_target_micros" bigint NOT NULL,
	"max_loss_micros" bigint NOT NULL,
	"drawdown_type" varchar(24) NOT NULL,
	"trailing_lock_at_micros" bigint,
	"daily_loss_limit_micros" bigint,
	"consistency_formula" varchar(32) NOT NULL,
	"consistency_threshold" real,
	"max_contracts" integer NOT NULL,
	"micros_count_as_fraction" boolean DEFAULT false NOT NULL,
	"min_trading_days" integer DEFAULT 0 NOT NULL,
	"max_trading_days" integer,
	"min_daily_pnl_to_count_micros" bigint DEFAULT 0 NOT NULL,
	"payout_rules" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"symbol" varchar(12) NOT NULL,
	"side" varchar(6) NOT NULL,
	"qty" integer NOT NULL,
	"entry_ticks" real NOT NULL,
	"exit_ticks" real NOT NULL,
	"entry_time" timestamp with time zone NOT NULL,
	"exit_time" timestamp with time zone NOT NULL,
	"gross_pnl_micros" bigint NOT NULL,
	"fees_micros" bigint NOT NULL,
	"net_pnl_micros" bigint NOT NULL,
	"trade_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(254) NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" varchar(60) NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_events" ADD CONSTRAINT "account_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_rule_template_id_rule_templates_id_fk" FOREIGN KEY ("rule_template_id") REFERENCES "public"."rule_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_indicators" ADD CONSTRAINT "chart_indicators_layout_id_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."layouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chart_states" ADD CONSTRAINT "chart_states_layout_id_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."layouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_account_stats" ADD CONSTRAINT "daily_account_stats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drawings" ADD CONSTRAINT "drawings_layout_id_layouts_id_fk" FOREIGN KEY ("layout_id") REFERENCES "public"."layouts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executions" ADD CONSTRAINT "executions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "layouts" ADD CONSTRAINT "layouts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "positions" ADD CONSTRAINT "positions_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "risk_events" ADD CONSTRAINT "risk_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_events_seq_key" ON "account_events" USING btree ("account_id","seq");--> statement-breakpoint
CREATE INDEX "account_events_type_idx" ON "account_events" USING btree ("account_id","type");--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chart_indicators_layout_chart_idx" ON "chart_indicators" USING btree ("layout_id","chart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chart_states_layout_chart_key" ON "chart_states" USING btree ("layout_id","chart_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_stats_account_date_key" ON "daily_account_stats" USING btree ("account_id","trade_date");--> statement-breakpoint
CREATE INDEX "drawings_layout_chart_idx" ON "drawings" USING btree ("layout_id","chart_id");--> statement-breakpoint
CREATE INDEX "executions_account_idx" ON "executions" USING btree ("account_id","exec_time");--> statement-breakpoint
CREATE INDEX "executions_order_idx" ON "executions" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "historical_bars_key" ON "historical_bars" USING btree ("symbol","timeframe","bar_time");--> statement-breakpoint
CREATE INDEX "historical_bars_scan_idx" ON "historical_bars" USING btree ("symbol","timeframe","bar_time");--> statement-breakpoint
CREATE INDEX "layouts_user_idx" ON "layouts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_client_id_key" ON "orders" USING btree ("account_id","client_order_id");--> statement-breakpoint
CREATE INDEX "orders_account_status_idx" ON "orders" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "orders_symbol_idx" ON "orders" USING btree ("symbol","status");--> statement-breakpoint
CREATE INDEX "orders_oco_idx" ON "orders" USING btree ("oco_group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "positions_account_symbol_key" ON "positions" USING btree ("account_id","symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "risk_events_account_idx" ON "risk_events" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "trades_account_idx" ON "trades" USING btree ("account_id","exit_time");--> statement-breakpoint
CREATE INDEX "trades_date_idx" ON "trades" USING btree ("account_id","trade_date");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");