import { Option, Predicate, Schema } from "effect";
import { isIP } from "node:net";

const maxMethodLength = 32;
const maxRouteLength = 256;
const maxTargetLength = 2048;
const maxAddressLength = 128;

const HttpMethod = Schema.NonEmptyString.check(
  Schema.isMaxLength(maxMethodLength),
  Schema.isPattern(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
);

const RouteTemplate = Schema.NonEmptyString.check(
  Schema.isMaxLength(maxRouteLength),
  Schema.isPattern(/^\/[\x21-\x7e]*$/),
  Schema.makeFilter(
    (route) =>
      !route.includes("//") &&
      !route.includes("\\") &&
      !route.includes("?") &&
      !route.includes("#") &&
      !route.includes("@") &&
      !route.includes("://"),
    { expected: "a bounded absolute route template without a URL authority or query" },
  ),
);

const RequestTarget = Schema.NonEmptyString.check(Schema.isMaxLength(maxTargetLength));
const NetworkAddress = Schema.NonEmptyString.check(
  Schema.isMaxLength(maxAddressLength),
  Schema.makeFilter((address) => isIP(address) !== 0, { expected: "an IP address" }),
);
const ServerAddress = Schema.NonEmptyString.check(
  Schema.isMaxLength(maxAddressLength),
  Schema.isPattern(/^[A-Za-z0-9.:[\]_-]+$/),
);
const NetworkPort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
);

const HttpRequestBoundary = Schema.Struct({ method: HttpMethod });
const ExpressRouteBoundary = Schema.Struct({ route: Schema.Struct({ path: RouteTemplate }) });
const FastifyRouteBoundary = Schema.Struct({
  routeOptions: Schema.Struct({ url: RouteTemplate }),
});
const HttpTargetBoundary = Schema.Struct({
  originalUrl: RequestTarget.pipe(Schema.optionalKey),
  url: RequestTarget.pipe(Schema.optionalKey),
});
const FrameworkProtocol = Schema.Literals(["http", "https"]);

const decodeHttpRequestBoundary = Schema.decodeUnknownOption(HttpRequestBoundary);
const decodeExpressRouteBoundary = Schema.decodeUnknownOption(ExpressRouteBoundary);
const decodeFastifyRouteBoundary = Schema.decodeUnknownOption(FastifyRouteBoundary);
const decodeHttpTargetBoundary = Schema.decodeUnknownOption(HttpTargetBoundary);
const decodeNetworkAddress = Schema.decodeUnknownOption(NetworkAddress);
const decodeServerAddress = Schema.decodeUnknownOption(ServerAddress);
const decodeNetworkPort = Schema.decodeUnknownOption(NetworkPort);
const decodeEncryptedSocket = Schema.decodeUnknownOption(Schema.Boolean);
const decodeFrameworkProtocol = Schema.decodeUnknownOption(FrameworkProtocol);
const decodeRouteTemplates = Schema.decodeUnknownOption(Schema.Array(RouteTemplate));

const knownMethods = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "TRACE",
]);

const defaultExcludedRoutes = ["/health", "/_telemetry/events"];
const staticSegmentPattern = /^[A-Za-z0-9._~-]+$/;
const parameterSegmentPattern = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const wildcardSegmentPattern = /^(?:\*[A-Za-z_][A-Za-z0-9_]*|\{\*[A-Za-z_][A-Za-z0-9_]*\})$/;

export type ProxyPolicy = "direct" | "framework";

export type TelemetryRoutePolicyOptions = {
  readonly healthRouteTemplates?: ReadonlyArray<string> | undefined;
  readonly proxyPolicy?: ProxyPolicy | undefined;
};

export type HttpServerRequest = {
  readonly method: string;
  readonly methodOriginal: Option.Option<string>;
  readonly route: Option.Option<string>;
  readonly spanName: string;
  readonly urlPath: Option.Option<string>;
  readonly urlScheme: Option.Option<string>;
  readonly clientAddress: Option.Option<string>;
  readonly networkPeerAddress: Option.Option<string>;
  readonly networkPeerPort: Option.Option<number>;
  readonly serverAddress: Option.Option<string>;
};

export type TelemetryRoutePolicy = {
  readonly inspect: (request: WeakKey) => Option.Option<HttpServerRequest>;
};

const normalizeRoute = (route: string): string =>
  route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;

const normalizedRoute = (request: WeakKey): Option.Option<string> =>
  decodeExpressRouteBoundary(request).pipe(
    Option.map((boundary) => normalizeRoute(boundary.route.path)),
    Option.orElse(() =>
      decodeFastifyRouteBoundary(request).pipe(
        Option.map((boundary) => normalizeRoute(boundary.routeOptions.url)),
      ),
    ),
  );

const normalizedMethod = (
  request: WeakKey,
): { readonly method: string; readonly original: Option.Option<string> } =>
  decodeHttpRequestBoundary(request).pipe(
    Option.match({
      onNone: () => ({ method: "_OTHER", original: Option.none() }),
      onSome: (boundary) => {
        const normalized = boundary.method.toUpperCase();
        const method = knownMethods.has(normalized) ? normalized : "_OTHER";
        return {
          method,
          original: boundary.method === method ? Option.none() : Option.some(boundary.method),
        };
      },
    }),
  );

const rawPath = (request: WeakKey): Option.Option<string> =>
  decodeHttpTargetBoundary(request).pipe(
    Option.flatMap((boundary) =>
      Option.fromNullishOr(boundary.originalUrl).pipe(
        Option.orElse(() => Option.fromNullishOr(boundary.url)),
      ),
    ),
    Option.filter(
      (target) =>
        target.startsWith("/") &&
        !target.startsWith("//") &&
        !target.includes("#") &&
        !target.includes("@") &&
        !target.includes("://"),
    ),
    Option.map((target) => target.split("?", 1)[0] ?? "/"),
    Option.map(normalizeRoute),
  );

const scrubPath = (request: WeakKey, route: string): Option.Option<string> =>
  rawPath(request).pipe(
    Option.flatMap((path) => {
      if (route === "/") {
        return path === "/" ? Option.some("/") : Option.none();
      }
      const routeSegments = route.split("/").slice(1);
      const pathSegments = path.split("/").slice(1);
      const scrubbed: Array<string> = [];
      for (let index = 0; index < routeSegments.length; index++) {
        const routeSegment = routeSegments[index] ?? "";
        const pathSegment = pathSegments[index];
        if (
          index === routeSegments.length - 1 &&
          wildcardSegmentPattern.test(routeSegment) &&
          pathSegment !== undefined
        ) {
          scrubbed.push("REDACTED");
          return Option.some(`/${scrubbed.join("/")}`);
        }
        if (pathSegment === undefined) {
          return Option.none();
        }
        if (parameterSegmentPattern.test(routeSegment)) {
          scrubbed.push("REDACTED");
        } else if (staticSegmentPattern.test(routeSegment) && routeSegment === pathSegment) {
          scrubbed.push(routeSegment);
        } else {
          return Option.none();
        }
      }
      if (pathSegments.length !== routeSegments.length) {
        return Option.none();
      }
      return Option.some(scrubbed.length === 0 ? "/" : `/${scrubbed.join("/")}`);
    }),
  );

const directNetwork = (
  request: WeakKey,
): Pick<
  HttpServerRequest,
  "urlScheme" | "clientAddress" | "networkPeerAddress" | "networkPeerPort" | "serverAddress"
> => {
  if (!Predicate.hasProperty(request, "socket")) {
    return {
      urlScheme: Option.some("http"),
      clientAddress: Option.none(),
      networkPeerAddress: Option.none(),
      networkPeerPort: Option.none(),
      serverAddress: Option.none(),
    };
  }
  const socket = request.socket;
  const address = Predicate.hasProperty(socket, "remoteAddress")
    ? decodeNetworkAddress(socket.remoteAddress)
    : Option.none<string>();
  const port = Predicate.hasProperty(socket, "remotePort")
    ? decodeNetworkPort(socket.remotePort)
    : Option.none<number>();
  const encrypted = Predicate.hasProperty(socket, "encrypted")
    ? decodeEncryptedSocket(socket.encrypted)
    : Option.none<boolean>();
  return {
    urlScheme: Option.some(Option.getOrElse(encrypted, () => false) ? "https" : "http"),
    clientAddress: address,
    networkPeerAddress: address,
    networkPeerPort: port,
    serverAddress: Option.none(),
  };
};

const frameworkNetwork = (
  request: WeakKey,
): Pick<
  HttpServerRequest,
  "urlScheme" | "clientAddress" | "networkPeerAddress" | "networkPeerPort" | "serverAddress"
> => {
  const direct = directNetwork(request);
  return {
    urlScheme: Predicate.hasProperty(request, "protocol")
      ? decodeFrameworkProtocol(request.protocol)
      : Option.none(),
    clientAddress: Predicate.hasProperty(request, "ip")
      ? decodeNetworkAddress(request.ip)
      : Option.none(),
    networkPeerAddress: direct.networkPeerAddress,
    networkPeerPort: direct.networkPeerPort,
    serverAddress: Predicate.hasProperty(request, "hostname")
      ? decodeServerAddress(request.hostname)
      : Option.none(),
  };
};

export const telemetryRoutePolicy = (
  options: TelemetryRoutePolicyOptions = {},
): TelemetryRoutePolicy => {
  const additionalExclusions = decodeRouteTemplates(options.healthRouteTemplates ?? []).pipe(
    Option.getOrThrowWith(
      () => new TypeError("Telemetry health route templates must be bounded absolute paths."),
    ),
  );
  const exclusions = new Set(
    [...defaultExcludedRoutes, ...additionalExclusions].map(normalizeRoute),
  );
  const proxyPolicy = options.proxyPolicy ?? "direct";
  if (proxyPolicy !== "direct" && proxyPolicy !== "framework") {
    throw new TypeError("Telemetry proxy policy must be direct or framework.");
  }
  return {
    inspect: (request) => {
      const route = normalizedRoute(request);
      if (Option.isSome(route) && exclusions.has(route.value)) {
        return Option.none();
      }
      const requestMethod = normalizedMethod(request);
      const network =
        proxyPolicy === "framework" ? frameworkNetwork(request) : directNetwork(request);
      const spanPrefix = requestMethod.method === "_OTHER" ? "HTTP" : requestMethod.method;
      return Option.some({
        method: requestMethod.method,
        methodOriginal: requestMethod.original,
        route,
        spanName: Option.match(route, {
          onNone: () => spanPrefix,
          onSome: (routeTemplate) => `${spanPrefix} ${routeTemplate}`,
        }),
        urlPath: Option.flatMap(route, (routeTemplate) => scrubPath(request, routeTemplate)),
        ...network,
      });
    },
  };
};

export const inspectHttpServerRequest = (
  request: WeakKey,
  options: TelemetryRoutePolicyOptions = {},
): Option.Option<HttpServerRequest> => telemetryRoutePolicy(options).inspect(request);
