import { renderToString } from "react-dom/server";
import { ServerRouter } from "react-router";
import { addDocumentResponseHeaders } from "./shopify.server";

export const streamTimeout = 5000;

export default async function handleRequest(
  request,
  responseStatusCode,
  responseHeaders,
  reactRouterContext,
) {
  addDocumentResponseHeaders(request, responseHeaders);
  const html = renderToString(
    <ServerRouter context={reactRouterContext} url={request.url} />,
  );

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");

  return new Response(`<!DOCTYPE html>${html}`, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
