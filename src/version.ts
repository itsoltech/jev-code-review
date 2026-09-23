declare const JEV_VERSION: string | undefined;

/** Set by the build from package.json; "dev" when run from source. */
export const VERSION: string = typeof JEV_VERSION === "string" ? JEV_VERSION : "dev";
