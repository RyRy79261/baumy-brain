CREATE TABLE "baumy_pending_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" text NOT NULL,
	"action_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"requested_by" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
