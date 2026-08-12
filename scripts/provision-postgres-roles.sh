#!/bin/sh
set -eu

: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_REGISTRY_PASSWORD:?POSTGRES_REGISTRY_PASSWORD is required}"
: "${POSTGRES_FACTORY_PASSWORD:?POSTGRES_FACTORY_PASSWORD is required}"
: "${POSTGRES_RUNTIME_PASSWORD:?POSTGRES_RUNTIME_PASSWORD is required}"
: "${POSTGRES_COMMERCE_PASSWORD:?POSTGRES_COMMERCE_PASSWORD is required}"

# Keep one operational database while enforcing table ownership with distinct
# login roles. This also upgrades an existing single-role Hatch database in
# place, so no corpus, Factory, conversation, or Commerce data is copied.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=database_name="$POSTGRES_DB" \
  --set=registry_password="$POSTGRES_REGISTRY_PASSWORD" \
  --set=factory_password="$POSTGRES_FACTORY_PASSWORD" \
  --set=runtime_password="$POSTGRES_RUNTIME_PASSWORD" \
  --set=commerce_password="$POSTGRES_COMMERCE_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE hatch_registry LOGIN PASSWORD %L', :'registry_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hatch_registry') \gexec
SELECT format('CREATE ROLE hatch_factory LOGIN PASSWORD %L', :'factory_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hatch_factory') \gexec
SELECT format('CREATE ROLE hatch_runtime LOGIN PASSWORD %L', :'runtime_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hatch_runtime') \gexec
SELECT format('CREATE ROLE hatch_commerce LOGIN PASSWORD %L', :'commerce_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hatch_commerce') \gexec

ALTER ROLE hatch_registry PASSWORD :'registry_password';
ALTER ROLE hatch_factory PASSWORD :'factory_password';
ALTER ROLE hatch_runtime PASSWORD :'runtime_password';
ALTER ROLE hatch_commerce PASSWORD :'commerce_password';

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CONNECT ON DATABASE :"database_name" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database_name" TO hatch_registry, hatch_factory, hatch_runtime, hatch_commerce;
GRANT USAGE, CREATE ON SCHEMA public TO hatch_registry, hatch_factory, hatch_runtime, hatch_commerce;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'accounts', 'agent_corpora', 'agent_access', 'tool_connections', 'agent_tool_bindings'
  ] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO hatch_registry', table_name);
    END IF;
  END LOOP;

  IF to_regclass('public.hatch_creator_factory_runs') IS NOT NULL THEN
    ALTER TABLE public.hatch_creator_factory_runs OWNER TO hatch_factory;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.hatch_creator_factory_runs TO hatch_registry;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'hatch_conversation_events', 'hatch_conversations', 'hatch_conversation_runs', 'hatch_conversation_journal'
  ] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO hatch_runtime', table_name);
    END IF;
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['commerce_events', 'commerce_outbox', 'commerce_inbox'] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I OWNER TO hatch_commerce', table_name);
    END IF;
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES FOR ROLE hatch_factory IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hatch_registry;
SQL
