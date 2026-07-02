CREATE TABLE "baumy_inbound_messages" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"chat_id" text NOT NULL,
	"from_id" bigint,
	"text" text,
	"raw" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
