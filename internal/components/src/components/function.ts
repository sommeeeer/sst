import fs from "fs";
import path from "path";
import crypto from "crypto";
import { globSync } from "glob";
import archiver from "archiver";
import type { Loader, BuildOptions } from "esbuild";
import pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { FunctionCodeUpdater } from "./function-code-updater.js";
import { AWS } from "./helpers/aws.js";

export interface FunctionNodeJSArgs {
  /**
   * Configure additional esbuild loaders for other file extensions
   *
   * @example
   * ```js
   * nodejs: {
   *   loader: {
   *    ".png": "file"
   *   }
   * }
   * ```
   */
  loader?: pulumi.Input<Record<string, Loader>>;

  /**
   * Packages that will be excluded from the bundle and installed into node_modules instead. Useful for dependencies that cannot be bundled, like those with binary dependencies.
   *
   * @example
   * ```js
   * nodejs: {
   *   install: ["pg"]
   * }
   * ```
   */
  install?: pulumi.Input<string[]>;

  /**
   * Use this to insert an arbitrary string at the beginning of generated JavaScript and CSS files.
   *
   * @example
   * ```js
   * nodejs: {
   *   banner: "console.log('Function starting')"
   * }
   * ```
   */
  banner?: pulumi.Input<string>;

  /**
   * This allows you to customize esbuild config.
   */
  esbuild?: pulumi.Input<BuildOptions>;

  /**
   * Enable or disable minification
   *
   * @default true
   *
   * @example
   * ```js
   * nodejs: {
   *   minify: false
   * }
   * ```
   */
  minify?: pulumi.Input<boolean>;
  /**
   * Configure format
   *
   * @default "esm"
   *
   * @example
   * ```js
   * nodejs: {
   *   format: "cjs"
   * }
   * ```
   */
  format?: pulumi.Input<"cjs" | "esm">;
  /**
   * Configure if sourcemaps are generated when the function is bundled for production. Since they increase payload size and potentially cold starts they are not generated by default. They are always generated during local development mode.
   *
   * @default false
   *
   * @example
   * ```js
   * nodejs: {
   *   sourcemap: true
   * }
   * ```
   */
  sourcemap?: pulumi.Input<boolean>;

  /**
   * If enabled, modules that are dynamically imported will be bundled as their own files with common dependencies placed in shared chunks. This can help drastically reduce cold starts as your function grows in size.
   *
   * @default false
   *
   * @example
   * ```js
   * nodejs: {
   *   splitting: true
   * }
   * ```
   */
  splitting?: pulumi.Input<boolean>;
}

export interface FunctionArgs
  extends Omit<
    aws.lambda.FunctionArgs,
    "handler" | "code" | "s3Bucket" | "s3Key" | "role" | "environment"
  > {
  bundle: pulumi.Input<string>;
  bundleHash?: pulumi.Input<string>;
  handler: pulumi.Input<string>;
  environment?: pulumi.Input<Record<string, pulumi.Input<string>>>;
  policies?: pulumi.Input<aws.types.input.iam.RoleInlinePolicy[]>;
  streaming?: pulumi.Input<boolean>;
  injections?: pulumi.Input<string[]>;
  region?: aws.Region;
  /**
   * Used to configure nodejs function properties
   */
  nodejs?: pulumi.Input<FunctionNodeJSArgs>;
}

export class Function extends pulumi.ComponentResource {
  private function: aws.lambda.Function;
  private role: aws.iam.Role;
  private missingSourcemap?: boolean;

  constructor(
    name: string,
    args: FunctionArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("sst:sst:Function", name, args, opts);

    const {
      handler,
      bundle,
      bundleHash: bundleHashRaw,
      environment,
      policies,
      streaming,
      injections,
      region,
    } = {
      environment: {},
      streaming: false,
      injections: [],
      ...args,
    };

    const provider = new aws.Provider(`${name}-provider`, {
      // TODO test these are not required
      //accessKey: app.aws.AWS_ACCESS_KEY_ID,
      //secretKey: app.aws.AWS_SECRET_ACCESS_KEY,
      //token: app.aws.AWS_SESSION_TOKEN,
      region: region || app.aws.region,
    });

    const bundleHash = bundleHashRaw ?? calculateHash(bundle);
    const newHandler = wrapHandler();
    const role = createRole();
    const zipFile = zipBundleFolder();
    const file = createBucketObject();
    const fn = createFunction();
    updateFunctionCode();

    this.function = fn;
    this.role = role;

    function calculateHash(bundle: pulumi.Input<string>) {
      return pulumi.all([bundle]).apply(async ([bundle]) => {
        const hash = crypto.createHash("sha256");
        const filePaths = globSync("**", {
          ignore: "**/node_modules/**",
          dot: true,
          nodir: true,
          follow: true,
          cwd: bundle,
        });

        for (const filePath of filePaths) {
          hash.update(
            await fs.promises.readFile(path.resolve(bundle, filePath)),
          );
        }

        return hash.digest("hex");
      });
    }

    function wrapHandler() {
      return pulumi
        .all([handler, bundle, injections])
        .apply(async ([handler, bundle, injections]) => {
          if (injections.length === 0) return handler;

          const {
            dir: handlerDir,
            name: oldHandlerName,
            ext: oldHandlerExt,
          } = path.posix.parse(handler);
          const oldHandlerFunction = oldHandlerExt.replace(/^\./, "");
          const newHandlerName = "server-index";
          const newHandlerFunction = "handler";
          await fs.promises.writeFile(
            path.join(bundle, handlerDir, `${newHandlerName}.mjs`),
            streaming
              ? [
                  `export const ${newHandlerFunction} = awslambda.streamifyResponse(async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerName}.mjs");`,
                  `  return rawHandler(event, context);`,
                  `});`,
                ].join("\n")
              : [
                  `export const ${newHandlerFunction} = async (event, context) => {`,
                  ...injections,
                  `  const { ${oldHandlerFunction}: rawHandler} = await import("./${oldHandlerName}.mjs");`,
                  `  return rawHandler(event, context);`,
                  `};`,
                ].join("\n"),
          );
          return path.posix.join(
            handlerDir,
            `${newHandlerName}.${newHandlerFunction}`,
          );
        });
    }

    function createRole() {
      return new aws.iam.Role(`${name}-role`, {
        assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({
          Service: "lambda.amazonaws.com",
        }),
        inlinePolicies: policies,
        managedPolicyArns: [
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
        ],
      });
    }

    function zipBundleFolder() {
      // Note: cannot point the bundle to the `.open-next/server-function`
      //       b/c the folder contains node_modules. And pnpm node_modules
      //       contains symlinks. Pulumi cannot zip symlinks correctly.
      //       We will zip the folder ourselves.
      return pulumi.all([bundle]).apply(async ([bundle]) => {
        const zipPath = path.resolve(app.paths.temp, name, "code.zip");
        await fs.promises.mkdir(path.dirname(zipPath), {
          recursive: true,
        });

        await new Promise(async (resolve, reject) => {
          const ws = fs.createWriteStream(zipPath);
          const archive = archiver("zip");
          archive.on("warning", reject);
          archive.on("error", reject);
          // archive has been finalized and the output file descriptor has closed, resolve promise
          // this has to be done before calling `finalize` since the events may fire immediately after.
          // see https://www.npmjs.com/package/archiver
          ws.once("close", () => {
            resolve(zipPath);
          });
          archive.pipe(ws);

          archive.glob("**", { cwd: bundle, dot: true });
          await archive.finalize();
        });

        return zipPath;
      });
    }

    function createBucketObject() {
      return new aws.s3.BucketObjectv2(
        `${name}-code`,
        {
          key: pulumi.interpolate`${name}-code-${bundleHash}.zip`,
          bucket: AWS.bootstrap.forRegion(region || app.aws.region),
          source: pulumi
            .all([zipFile])
            .apply(([zipFile]) => new pulumi.asset.FileArchive(zipFile)),
        },
        {
          provider,
        },
      );
    }

    function createFunction() {
      return new aws.lambda.Function(
        `${name}-function`,
        {
          code: new pulumi.asset.AssetArchive({
            index: new pulumi.asset.StringAsset("exports.handler = () => {}"),
          }),
          role: role.arn,
          ...args,
          handler: newHandler,
          environment: {
            variables: environment,
          },
        },
        { provider },
      );
    }

    function updateFunctionCode() {
      new FunctionCodeUpdater(`${name}-code-updater`, {
        functionName: fn.name,
        s3Bucket: file.bucket,
        s3Key: file.key,
        region,
      });
    }
  }

  public get aws() {
    return {
      function: this.function,
      role: this.role,
    };
  }

  /** @internal */
  public getConstructMetadata() {
    return {
      type: "Function" as const,
      data: {
        arn: this.function.arn,
        runtime: this.function.runtime,
        handler: this.function.handler,
        missingSourcemap: this.missingSourcemap === true ? true : undefined,
        localId: this.urn,
        secrets: [] as string[],
      },
    };
  }
}
