## file_length_and_structure

Never allow a file to exceed 500 lines.
If a file approaches 400 lines, split it immediately.
Treat 1000 lines as unacceptable, even temporarily.
Use folders and naming conventions to keep small files logically grouped.

## function_and_class_size

Keep functions under 30-40 lines.
If a class is over 200 lines, split it into smaller collaborators.

## naming_and_readability

All class, method, and variable names must be descriptive and intention-revealing.
Avoid vague names like `data`, `info`, `helper`, or `temp`.

## documentation_governance

`docs/` is the canonical documentation source for this repository.

### core_rules
- Keep canonical docs English-first.
- Canonical docs must describe current behavior only. Do not keep changelog/history narrative in canonical pages.
- Do not duplicate full specs across files. Link to the canonical page instead.

### completion_gate
- Any feature, refactor, behavior change, API change, configuration change, or data-model change is incomplete until impacted docs in `docs/` are updated in the same task.
- If a change makes existing docs stale, remove or rewrite stale sections in the same task.

### minimum_doc_impact_review
For each substantial code task, review whether updates are needed in:

## scalability_mindset

Always code as if someone else will scale this.
Include extension points (for example: protocol conformance, dependency injection) from day one.
