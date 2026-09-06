# Boundary fixtures

The projects contain synthetic dependencies for package-boundary tests. Their versions do not describe installed application dependencies.

Store fixture manifests as `package.json.fixture`. The test harness copies the projects into a temporary directory and renames these files to `package.json`. It removes the temporary projects after the suite.

Do not commit real `package.json` files under `projects/`. GitHub dependency discovery treats those files as application manifests and creates irrelevant security alerts.

Keep dependency scanning enabled for the real workspace manifests and lockfile.
