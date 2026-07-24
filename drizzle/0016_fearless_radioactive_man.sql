CREATE TABLE "hitl_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb,
	"requested_by" text NOT NULL,
	"answered_by" text,
	"expires_at" timestamp with time zone,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hitl_requests_status_check" CHECK ("hitl_requests"."status" IN ('pending', 'answered', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hitl_requests_requester_request_id_uidx" ON "hitl_requests" USING btree ("requested_by","request_id");--> statement-breakpoint
CREATE INDEX "hitl_requests_status_expiry_idx" ON "hitl_requests" USING btree ("status","expires_at");