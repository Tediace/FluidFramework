This folder contains configuration information for routerlicious. Some secret values are empty and will need to be filled in, e.g. the translation key in config.json. These can also be set as environment vairables and loaded that way. The format of environment variable name depends on how the variable is loaded by nconf, e.g. worker.intelligence.translation.key in config.json is loaded as intelligence__translation__key from an environment variable since it is loaded form the worker config.

If you have access to the prague keyvault you can either manually copy the keys you need into environment variables or config.json, or you can run the script located in [Prague/tools/getkeys](../../../../tools/getkeys) to load and set them all to environment variables. In order to have access to the prague keyvault you must be a member of the prague-secrets security group.