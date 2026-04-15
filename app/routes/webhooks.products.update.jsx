import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  const { payload, shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook payload uses numeric IDs; our DB stores GIDs
  const productGid = `gid://shopify/Product/${payload.id}`;

  // Build a map of variantGid -> variant data from the payload
  const variantMap = new Map();
  for (const v of payload.variants ?? []) {
    const variantGid = `gid://shopify/ProductVariant/${v.id}`;
    // A variant is available if inventory isn't tracked, or if quantity > 0
    const availableForSale =
      v.inventory_management === null || (v.inventory_quantity ?? 0) > 0;
    variantMap.set(variantGid, {
      title: v.title ?? "",
      sku: v.sku ?? "",
      price: v.price ?? "0",
      availableForSale,
    });
  }

  // Shopify sends the first image in the images array as the featured image
  const productImage =
    payload.images?.[0]?.src ?? null;

  // Find every StorefrontProduct row for this product across all storefronts of this shop
  const rows = await db.storefrontProduct.findMany({
    where: {
      shopifyProductId: productGid,
      storefront: { shopDomain: shop },
    },
    select: { id: true, shopifyVariantId: true },
  });

  if (rows.length === 0) {
    // Product isn't used in any storefront for this shop — nothing to do
    return new Response();
  }

  // Update each row individually so per-variant data stays accurate
  await Promise.all(
    rows.map((row) => {
      const variant = variantMap.get(row.shopifyVariantId);
      return db.storefrontProduct.update({
        where: { id: row.id },
        data: {
          productTitle: payload.title ?? undefined,
          productImage: productImage,
          ...(variant
            ? {
                variantTitle: variant.title,
                variantSku: variant.sku,
                basePrice: variant.price,
                availableForSale: variant.availableForSale,
              }
            : {}),
        },
      });
    }),
  );

  console.log(
    `Synced ${rows.length} StorefrontProduct row(s) for product ${productGid} (shop: ${shop})`,
  );

  return new Response();
};
