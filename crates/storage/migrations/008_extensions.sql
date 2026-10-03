CREATE TABLE extension_versions (digest TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE extension_installations (id TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), UNIQUE(scope,slug));
CREATE TABLE extension_previews (id TEXT PRIMARY KEY, data_json TEXT NOT NULL CHECK(json_valid(data_json)), consumed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE extension_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, installation_id TEXT, action TEXT NOT NULL, at_ms INTEGER NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)));
CREATE TABLE extension_catalogs (installation_id TEXT NOT NULL, server_id TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), PRIMARY KEY(installation_id,server_id));
CREATE TABLE extension_credentials (installation_id TEXT NOT NULL, server_id TEXT NOT NULL, key TEXT NOT NULL, credential_ref TEXT NOT NULL, PRIMARY KEY(installation_id,server_id,key));
