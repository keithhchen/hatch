# Creator Skill Modules

A creator skill module lives under:

```text
creator-server/skills/<app_id>/
  SKILL.md
  references/   optional
  scripts/      optional
  assets/       optional
```

Hatch follows the current Skill structure: a self-contained folder with a required `SKILL.md`. The YAML frontmatter contains `name` and `description`; Hatch-specific distribution metadata lives under `metadata.hatch`. The Markdown body is the protected creator logic loaded into the OpenAI Agents SDK.

## Edit The Current Skill

Edit:

```text
creator-server/skills/app_lorem_creator/SKILL.md
```

Then restart `./scripts/dev.sh` so the Creator Server reloads the module. Open the Creator Console at `http://127.0.0.1:8200/`, load the public manifest, and submit it to Platform. The private `SKILL.md` body stays in Creator Runtime.

## Create A New Skill

Copy the folder:

```bash
cp -R creator-server/skills/app_lorem_creator creator-server/skills/app_notes_creator
```

Then edit `creator-server/skills/app_notes_creator/SKILL.md`:

- `name`
- `description`
- `metadata.hatch.app_id`
- `metadata.hatch.version`
- `metadata.hatch.distribution.manifest_url`
- `metadata.hatch.license.policy_id`

Edit the Markdown body with the new skill behavior. Keep tools constrained to:

```yaml
metadata:
  hatch:
    tools:
      - local.search
      - local.list
      - local.read
      - local.write
```

In the desktop app, click `Refresh Registry`, then install it from the registry list.

The Creator Server chooses the module by `runtime.hello.app_id`; the Platform Registry only stores signed metadata and does not see `instructions.md`.
