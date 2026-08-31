import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      return new Response();

    case "SHOP_REDACT":
      await db.session.deleteMany({ where: { shop } });
      return new Response();

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }
};
