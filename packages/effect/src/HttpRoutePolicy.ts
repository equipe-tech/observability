import { Effect, Option, Schema } from "effect";
import type { Headers, HttpServerRequest } from "effect/unstable/http";
import { isIP } from "node:net";

const maxRouteLength = 256;
const maxTargetLength = 2048;
const maxAddressLength = 128;

export const RouteTemplate = Schema.NonEmptyString.check(
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
const ForwardedProtocol = Schema.Literals(["http", "https"]);
const NodeSocketSource = Schema.Struct({
  socket: Schema.Struct({
    encrypted: Schema.Boolean.pipe(Schema.optionalKey),
    remotePort: NetworkPort.pipe(Schema.optionalKey),
  }),
});
const WebRequestSource = Schema.Struct({ url: Schema.String });

const decodeRequestTarget = Schema.decodeUnknownOption(RequestTarget);
const decodeNetworkAddress = Schema.decodeUnknownOption(NetworkAddress);
const decodeServerAddress = Schema.decodeUnknownOption(ServerAddress);
const decodeForwardedProtocol = Schema.decodeUnknownOption(ForwardedProtocol);
const decodeNodeSocketSource = Schema.decodeUnknownOption(NodeSocketSource);
const decodeWebRequestSource = Schema.decodeUnknownOption(WebRequestSource);
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

export const defaultExcludedRoutes: ReadonlyArray<string> = ["/health", "/_telemetry/events"];
const staticSegmentPattern = /^[A-Za-z0-9._~-]+$/;
const parameterSegmentPattern = /^:[A-Za-z_][A-Za-z0-9_]*$/;
const wildcardSegmentPattern = /^(?:\*|\*[A-Za-z_][A-Za-z0-9_]*|\{\*[A-Za-z_][A-Za-z0-9_]*\})$/;

export type ProxyPolicy = "direct" | "framework";

export type TelemetryRoutePolicyOptions = {
  readonly healthRouteTemplates?: ReadonlyArray<string> | undefined;
  readonly proxyPolicy?: ProxyPolicy | undefined;
};

export type HttpServerRequestDetails = {
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
  readonly inspect: (
    request: HttpServerRequest.HttpServerRequest,
    routeTemplate: Option.Option<string>,
  ) => Option.Option<HttpServerRequestDetails>;
};

export class InvalidTelemetryRoutePolicy extends Schema.TaggedError<InvalidTelemetryRoutePolicy>()(
  "InvalidTelemetryRoutePolicy",
  {
    code: Schema.Literal("OBS_EFFECT_ROUTE_POLICY_INVALID"),
    message: Schema.String,
    field: Schema.Literals(["healthRouteTemplates", "proxyPolicy"]),
  },
) {}

const normalizeRoute = (route: string): string =>
  route.length > 1 && route.endsWith("/") ? route.slice(0, -1) : route;

const normalizedRoute = (routeTemplate: Option.Option<string>): Option.Option<string> =>
  routeTemplate.pipe(
    Option.flatMap((template) => Schema.decodeUnknownOption(RouteTemplate)(template)),
    Option.map(normalizeRoute),
  );

const normalizedMethod = (
  request: HttpServerRequest.HttpServerRequest,
): { readonly method: string; readonly original: Option.Option<string> } => {
  const normalized = request.method.toUpperCase();
  const method = knownMethods.has(normalized) ? normalized : "_OTHER";
  return {
    method,
    original: request.method === method ? Option.none() : Option.some(request.method),
  };
};

const rawPath = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
  decodeRequestTarget(request.originalUrl).pipe(
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

const scrubPath = (
  request: HttpServerRequest.HttpServerRequest,
  route: string,
): Option.Option<string> =>
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

type NetworkDetails = Pick<
  HttpServerRequestDetails,
  "urlScheme" | "clientAddress" | "networkPeerAddress" | "networkPeerPort" | "serverAddress"
>;

const sourceScheme = (request: HttpServerRequest.HttpServerRequest): Option.Option<string> =>
  decodeWebRequestSource(request.source).pipe(
    Option.flatMap((web) => {
      try {
        return decodeForwardedProtocol(new URL(web.url).protocol.slice(0, -1));
      } catch {
        return Option.none();
      }
    }),
    Option.orElse(() =>
      decodeNodeSocketSource(request.source).pipe(
        Option.map((node) => (node.socket.encrypted === true ? "https" : "http")),
      ),
    ),
  );

const sourcePeerPort = (request: HttpServerRequest.HttpServerRequest): Option.Option<number> =>
  decodeNodeSocketSource(request.source).pipe(
    Option.flatMap((node) => Option.fromNullishOr(node.socket.remotePort)),
  );

const directNetwork = (request: HttpServerRequest.HttpServerRequest): NetworkDetails => {
  const address = Option.flatMap(request.remoteAddress, decodeNetworkAddress);
  return {
    urlScheme: Option.some(Option.getOrElse(sourceScheme(request), () => "http")),
    clientAddress: address,
    networkPeerAddress: address,
    networkPeerPort: sourcePeerPort(request),
    serverAddress: Option.none(),
  };
};

const headerValue = (headers: Headers.Headers, name: string): Option.Option<string> =>
  Option.fromNullishOr(headers[name]);

const hostWithoutPort = (host: string): string => {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const separator = host.indexOf(":");
  return separator === -1 ? host : host.slice(0, separator);
};

const frameworkNetwork = (request: HttpServerRequest.HttpServerRequest): NetworkDetails => {
  const direct = directNetwork(request);
  const forwardedFor = headerValue(request.headers, "x-forwarded-for").pipe(
    Option.map((value) => value.split(",")[0]?.trim() ?? ""),
    Option.flatMap(decodeNetworkAddress),
  );
  const host = headerValue(request.headers, "x-forwarded-host").pipe(
    Option.orElse(() => headerValue(request.headers, "host")),
    Option.map(hostWithoutPort),
    Option.flatMap(decodeServerAddress),
  );
  return {
    urlScheme: headerValue(request.headers, "x-forwarded-proto").pipe(
      Option.flatMap(decodeForwardedProtocol),
    ),
    clientAddress: forwardedFor,
    networkPeerAddress: direct.networkPeerAddress,
    networkPeerPort: direct.networkPeerPort,
    serverAddress: host,
  };
};

const decodeProxyPolicy = Schema.decodeUnknownOption(Schema.Literals(["direct", "framework"]));

export const telemetryRoutePolicy = Effect.fnUntraced(function* (
  options: TelemetryRoutePolicyOptions = {},
): Effect.fn.Return<TelemetryRoutePolicy, InvalidTelemetryRoutePolicy> {
  const additionalExclusions = decodeRouteTemplates(options.healthRouteTemplates ?? []);
  if (Option.isNone(additionalExclusions)) {
    return yield* new InvalidTelemetryRoutePolicy({
      code: "OBS_EFFECT_ROUTE_POLICY_INVALID",
      message:
        "Telemetry health route templates must be bounded absolute paths. Fix healthRouteTemplates before starting the server.",
      field: "healthRouteTemplates",
    });
  }
  const proxyPolicy = decodeProxyPolicy(options.proxyPolicy ?? "direct");
  if (Option.isNone(proxyPolicy)) {
    return yield* new InvalidTelemetryRoutePolicy({
      code: "OBS_EFFECT_ROUTE_POLICY_INVALID",
      message:
        "Telemetry proxy policy must be direct or framework. Fix proxyPolicy before starting the server.",
      field: "proxyPolicy",
    });
  }
  const exclusions = new Set(
    [...defaultExcludedRoutes, ...additionalExclusions.value].map(normalizeRoute),
  );
  const network = proxyPolicy.value === "framework" ? frameworkNetwork : directNetwork;
  return {
    inspect: (request, routeTemplate) => {
      const route = normalizedRoute(routeTemplate);
      if (Option.isSome(route) && exclusions.has(route.value)) {
        return Option.none();
      }
      const requestMethod = normalizedMethod(request);
      const spanPrefix = requestMethod.method === "_OTHER" ? "HTTP" : requestMethod.method;
      return Option.some({
        method: requestMethod.method,
        methodOriginal: requestMethod.original,
        route,
        spanName: Option.match(route, {
          onNone: () => spanPrefix,
          onSome: (template) => `${spanPrefix} ${template}`,
        }),
        urlPath: Option.flatMap(route, (template) => scrubPath(request, template)),
        ...network(request),
      });
    },
  };
});

export const inspectHttpServerRequest = (
  request: HttpServerRequest.HttpServerRequest,
  routeTemplate: Option.Option<string>,
  options: TelemetryRoutePolicyOptions = {},
): Effect.Effect<Option.Option<HttpServerRequestDetails>, InvalidTelemetryRoutePolicy> =>
  Effect.map(telemetryRoutePolicy(options), (policy) => policy.inspect(request, routeTemplate));
