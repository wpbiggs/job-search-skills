# Contributing

Contributions that make job seeking more accurate, accessible, and candidate-controlled are welcome.

1. Open an issue describing the user need with fictional or fully anonymized examples.
2. Keep skills portable: YAML frontmatter with `name` and `description`, explicit inputs, steps, outputs, and safety boundaries.
3. Never add real candidate data, credentials, browser sessions, private application histories, or copied employer correspondence.
4. Avoid vendor lock-in, inflated capability claims, arbitrary “hireability” scores, and autonomous submissions.
5. Add regression tests for script changes. Run `python3 -m unittest discover -s tests -v` from the repository root.
6. Describe behavior changes, manual verification, and limitations in your pull request. Browser integrations must document their privacy implications and distinguish prompt rules from enforced restrictions.

No contributions are sent upstream to browser projects automatically. Follow each project's contribution rules, including its policies on AI-generated contributions.
