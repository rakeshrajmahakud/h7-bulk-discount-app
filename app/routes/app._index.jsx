import { useMemo, useState } from "react";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

const TAB_OPTIONS = ["All", "Active", "Scheduled", "Expired"];
const TYPE_OPTIONS = [
  "All types",
  "Store-wide",
  "Product specific",
  "Collection specific",
];

function normalizeNumber(value) {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function getDiscountType(discount) {
  const itemsType = discount.customerGets?.items?.__typename ?? "";

  if (itemsType.toLowerCase().includes("collection")) return "Collection specific";
  if (itemsType.toLowerCase().includes("product")) return "Product specific";
  return "Store-wide";
}

function getStatus(discount, now = Date.now()) {
  const startsAt = discount.startsAt ? Date.parse(discount.startsAt) : null;
  const endsAt = discount.endsAt ? Date.parse(discount.endsAt) : null;

  if (endsAt && endsAt < now) {
    return { label: "Expired", tone: "neutral" };
  }

  if (startsAt && startsAt > now) {
    return { label: "Scheduled", tone: "warning" };
  }

  return { label: "Active", tone: "success" };
}

function getFormattedValue(discount) {
  const value = discount.customerGets?.value;

  if (!value) return "Custom";

  if (value.__typename === "DiscountPercentage") {
    return `${(normalizeNumber(value.percentage) * 100).toFixed(0)}% off`;
  }

  if (value.__typename === "DiscountAmount") {
    return `${formatCurrency(normalizeNumber(value.amount?.amount))} off`;
  }

  return discount.valueType ?? "Custom";
}

function estimateImpact(discount, redemptions) {
  const value = discount.customerGets?.value;
  if (!value) return 0;

  const amount =
    value.__typename === "DiscountPercentage"
      ? normalizeNumber(value.percentage)
      : normalizeNumber(value.amount?.amount);

  return redemptions * amount;
}

function buildTrendPoints(rows) {
  const days = 14;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (days - 1));

  const buckets = Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);

    return {
      label: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      value: 0,
    };
  });

  for (const row of rows) {
    if (!row.createdAt) continue;

    const createdAt = Date.parse(row.createdAt);
    if (!Number.isFinite(createdAt)) continue;

    const bucketIndex = Math.floor((createdAt - start.getTime()) / 86400000);
    if (bucketIndex < 0 || bucketIndex >= days) continue;

    buckets[bucketIndex].value += row.redemptions > 0 ? row.redemptions : 1;
  }

  let runningTotal = 0;
  return buckets.map((bucket) => {
    runningTotal += bucket.value;
    return runningTotal;
  });
}

function buildPath(values, width, height, padding = 18) {
  if (values.length === 0) return "";

  const max = Math.max(...values, 1);
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const step = values.length === 1 ? 0 : innerWidth / (values.length - 1);

  return values
    .map((value, index) => {
      const x = padding + step * index;
      const y = padding + innerHeight - (value / max) * innerHeight;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function mapDiscountNode(node) {
  const discount = node.codeDiscount ?? node.discount ?? node;
  const codes = discount.codes?.nodes ?? [];
  const redemptions = codes.reduce(
    (sum, code) => sum + normalizeNumber(code.usageCount ?? 0),
    0,
  );
  const status = getStatus(discount);

  return {
    id: node.id,
    discount: discount.title || codes[0]?.code || "Untitled discount",
    type: getDiscountType(discount),
    status: status.label,
    statusTone: status.tone,
    value: getFormattedValue(discount),
    used: redemptions.toLocaleString("en-US"),
    createdAt: discount.createdAt ?? discount.startsAt ?? null,
    rawRedemptions: redemptions,
    estimatedImpact: estimateImpact(discount, redemptions),
  };
}

function buildTableRows(nodes) {
  return nodes
    .map(mapDiscountNode)
    .sort((a, b) => {
      const left = a.createdAt ? Date.parse(a.createdAt) : 0;
      const right = b.createdAt ? Date.parse(b.createdAt) : 0;
      return right - left;
    });
}

function getDiscountQuery({ rootField, discountField, includeUsageCount }) {
  return `#graphql
    query DiscountDashboard($first: Int!, $after: String) {
      ${rootField}(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          ${discountField} {
            __typename
            ... on DiscountCodeBasic {
              title
              createdAt
              startsAt
              endsAt
              usageLimit
              customerGets {
                items {
                  __typename
                }
                value {
                  __typename
                  ... on DiscountPercentage {
                    percentage
                  }
                  ... on DiscountAmount {
                    amount {
                      amount
                      currencyCode
                    }
                  }
                }
              }
              codes(first: 250) {
                nodes {
                  code
                  ${includeUsageCount ? "usageCount" : ""}
                }
              }
            }
          }
        }
      }
    }`;
}

async function fetchAllDiscountNodes(admin, variant) {
  const nodes = [];
  let after = null;

  while (true) {
    const response = await admin.graphql(getDiscountQuery(variant), {
      variables: {
        first: 50,
        after,
      },
    });

    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors[0].message);
    }

    const connection = json.data?.[variant.rootField];
    if (!connection) {
      throw new Error(`Missing ${variant.rootField} in discount dashboard response`);
    }

    nodes.push(...(connection.nodes ?? []));

    if (!connection.pageInfo?.hasNextPage) {
      break;
    }

    after = connection.pageInfo.endCursor;
  }

  return nodes;
}

async function loadDiscountDashboard(admin) {
  const variants = [
    { rootField: "codeDiscountNodes", discountField: "codeDiscount", includeUsageCount: true },
    { rootField: "codeDiscountNodes", discountField: "codeDiscount", includeUsageCount: false },
    { rootField: "discountNodes", discountField: "discount", includeUsageCount: true },
    { rootField: "discountNodes", discountField: "discount", includeUsageCount: false },
  ];

  let lastError = null;

  for (const variant of variants) {
    try {
      const nodes = await fetchAllDiscountNodes(admin, variant);
      const rows = buildTableRows(nodes);
      const totalDiscountsCreated = rows.length;
      const activeNow = rows.filter((row) => row.status === "Active").length;
      const totalRedemptions = rows.reduce((sum, row) => sum + row.rawRedemptions, 0);
      const estimatedRevenueImpact = rows.reduce(
        (sum, row) => sum + row.estimatedImpact,
        0,
      );
      const lineTrend = buildTrendPoints(rows);
      const typeCounts = rows.reduce(
        (acc, row) => {
          acc[row.type] = (acc[row.type] || 0) + 1;
          return acc;
        },
        {
          "Store-wide": 0,
          "Product specific": 0,
          "Collection specific": 0,
        },
      );

      return {
        ok: true,
        totalDiscountsCreated,
        activeNow,
        totalRedemptions,
        estimatedRevenueImpact,
        rows,
        lineTrend,
        typeCounts,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Failed to load discount dashboard");
}

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);
    return await loadDiscountDashboard(admin);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to load discount dashboard",
      totalDiscountsCreated: 0,
      activeNow: 0,
      totalRedemptions: 0,
      estimatedRevenueImpact: 0,
      rows: [],
      lineTrend: Array.from({ length: 14 }, () => 0),
      typeCounts: {
        "Store-wide": 0,
        "Product specific": 0,
        "Collection specific": 0,
      },
    };
  }
};

function MetricCard({ label, value }) {
  return (
    <s-card padding="base" style={{ flex: "1 1 0", minWidth: "180px" }}>
      <s-stack gap="small">
        <s-paragraph style={{ margin: 0 }}>{label}</s-paragraph>
        <s-heading style={{ margin: 0, fontSize: "2rem", lineHeight: 1.05 }}>
          {value}
        </s-heading>
      </s-stack>
    </s-card>
  );
}

function LineChart({ values }) {
  const width = 560;
  const height = 260;
  const path = buildPath(values, width, height);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height="260"
      role="img"
      aria-label="Discount activity over the last 14 days"
    >
      {path && (
        <>
          <path
            d={`${path} L ${width - 18} ${height - 18} L 18 ${height - 18} Z`}
            fill="rgba(22, 163, 106, 0.05)"
          />
          <path
            d={path}
            fill="none"
            stroke="#16a36a"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {values.map((value, index) => {
            const max = Math.max(...values, 1);
            const innerWidth = width - 36;
            const innerHeight = height - 36;
            const step = values.length === 1 ? 0 : innerWidth / (values.length - 1);
            const cx = 18 + step * index;
            const cy = 18 + innerHeight - (value / max) * innerHeight;

            return <circle key={`${index}-${value}`} cx={cx} cy={cy} r="4" fill="#16a36a" />;
          })}
        </>
      )}
    </svg>
  );
}

function DonutChart({ counts }) {
  const values = [
    { label: "Store-wide", value: counts["Store-wide"] || 0, color: "#7c76df" },
    { label: "Product", value: counts["Product specific"] || 0, color: "#1ea672" },
    { label: "Collection", value: counts["Collection specific"] || 0, color: "#e45d2d" },
  ];

  const total = values.reduce((sum, item) => sum + item.value, 0) || 1;
  const radius = 56;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <svg viewBox="0 0 220 220" width="220" height="220" role="img" aria-label="Discounts by type">
      <circle cx="110" cy="110" r={radius} fill="none" stroke="#f3f4f6" strokeWidth="28" />
      {values.map((item) => {
        const dash = (item.value / total) * circumference;
        const circle = (
          <circle
            key={item.label}
            cx="110"
            cy="110"
            r={radius}
            fill="none"
            stroke={item.color}
            strokeWidth="28"
            strokeDasharray={`${dash} ${circumference - dash}`}
            strokeDashoffset={offset}
            transform="rotate(-90 110 110)"
          />
        );
        offset -= dash;
        return circle;
      })}
      <circle cx="110" cy="110" r="36" fill="#ffffff" />
    </svg>
  );
}

export default function Index() {
  const navigate = useNavigate();
  const data = useLoaderData();
  const [activeTab, setActiveTab] = useState("All");
  const [activeType, setActiveType] = useState("All types");
  const hasDiscounts = data.rows.length > 0;
  const activitySummary =
    data.totalRedemptions > 0
      ? data.totalRedemptions.toLocaleString("en-US")
      : "No activity yet";

  const filteredRows = useMemo(() => {
    return data.rows.filter((row) => {
      const matchesTab = activeTab === "All" || row.status === activeTab;
      const matchesType = activeType === "All types" || row.type === activeType;
      return matchesTab && matchesType;
    });
  }, [activeTab, activeType, data.rows]);

  const visibleRows = filteredRows.slice(0, 4);

  return (
    <s-page
      heading="Discounts"
      inlineSize="base"
      primaryAction={
        <s-button variant="primary" onClick={() => navigate("/app/creatediscount")}>
          + Create discount
        </s-button>
      }
    >
      <s-card
        padding="base"
        style={{
          borderRadius: "20px",
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.04), 0 12px 30px rgba(0, 0, 0, 0.05)",
        }}
      >
        <s-stack gap="large">
          <s-stack gap="small">
            
            <s-heading padding>
              Discount Analytics
            </s-heading>
            {!data.ok && (
              <s-banner tone="critical" padding="base">
                {data.error}
              </s-banner>
            )}
          </s-stack>

          {hasDiscounts ? (
            <s-section heading="Analytics overview" padding="base">
              <s-card padding="base">
                <s-stack gap="large">
                  <s-stack
                    direction="inline"
                    style={{
                      gap: "16px",
                      alignItems: "stretch",
                      flexWrap: "wrap",
                    }}
                  >
                    <s-card
                      padding="base"
                      style={{ flex: "2 1 560px", minHeight: "320px" }}
                    >
                      <s-stack gap="base">
                        <s-box
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: "16px",
                            width: "100%",
                          }}
                        >
                          <s-paragraph style={{ margin: 0, flex: "1 1 auto" }}>
                            Discount activity — last 14 days
                          </s-paragraph>
                          <s-paragraph
                            style={{
                              margin: 0,
                              fontWeight: 600,
                              flex: "0 0 auto",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {activitySummary}
                          </s-paragraph>
                        </s-box>
                        <LineChart values={data.lineTrend} />
                      </s-stack>
                    </s-card>

                    <s-card
                      padding="base"
                      style={{ flex: "1 1 280px", minHeight: "320px" }}
                    >
                      <s-stack gap="base" style={{ alignItems: "center" }}>
                        <s-paragraph style={{ margin: 0, alignSelf: "stretch" }}>
                          Discounts by type
                        </s-paragraph>
                        <DonutChart counts={data.typeCounts} />
                        <s-stack gap="small" style={{ alignSelf: "stretch" }}>
                          <s-stack direction="inline" gap="small" style={{ alignItems: "center" }}>
                            <span
                              style={{
                                width: "12px",
                                height: "12px",
                                borderRadius: "3px",
                                background: "#7c76df",
                                display: "inline-block",
                              }}
                            />
                            <s-paragraph style={{ margin: 0 }}>Store-wide</s-paragraph>
                          </s-stack>
                          <s-stack direction="inline" gap="small" style={{ alignItems: "center" }}>
                            <span
                              style={{
                                width: "12px",
                                height: "12px",
                                borderRadius: "3px",
                                background: "#1ea672",
                                display: "inline-block",
                              }}
                            />
                            <s-paragraph style={{ margin: 0 }}>Product</s-paragraph>
                          </s-stack>
                          <s-stack direction="inline" gap="small" style={{ alignItems: "center" }}>
                            <span
                              style={{
                                width: "12px",
                                height: "12px",
                                borderRadius: "3px",
                                background: "#e45d2d",
                                display: "inline-block",
                              }}
                            />
                            <s-paragraph style={{ margin: 0 }}>Collection</s-paragraph>
                          </s-stack>
                        </s-stack>
                      </s-stack>
                    </s-card>
                  </s-stack>

                  <s-stack direction="inline" gap="base" style={{ flexWrap: "wrap" }}>
                    <MetricCard
                      label="Total discounts created"
                      value={data.totalDiscountsCreated.toLocaleString("en-US")}
                    />
                    <MetricCard
                      label="Active now"
                      value={data.activeNow.toLocaleString("en-US")}
                    />
                    <MetricCard
                      label="Total redemptions"
                      value={data.totalRedemptions.toLocaleString("en-US")}
                    />
                    <MetricCard
                      label="Estimated revenue impact"
                      value={formatCurrency(data.estimatedRevenueImpact)}
                    />
                  </s-stack>
                </s-stack>
              </s-card>
            </s-section>
          ) : (
            <s-card padding="base">
              <s-box
                padding="base"
                style={{
                  minHeight: "320px",
                  display: "grid",
                  placeItems: "center",
                  textAlign: "center",
                }}
              >
                <s-stack gap="base" style={{ maxWidth: "560px" }}>
                  <s-heading style={{ margin: 0, fontSize: "2rem", lineHeight: 1.1 }}>
                    Create discount to see the analytics
                  </s-heading>
                  <s-paragraph style={{ margin: 0 }}>
                    Your dashboard will show discount performance, type breakdown, and activity
                    here once you create your first discount.
                  </s-paragraph>
                  <s-stack direction="inline" style={{ justifyContent: "center" }}>
                    <s-button variant="primary" onClick={() => navigate("/app/creatediscount")}>
                      Create discount
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            </s-card>
          )}

          <s-card padding="base">
            <s-stack gap="large">
              <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap" }}>
                {TAB_OPTIONS.map((tab) => (
                  <s-button
                    key={tab}
                    padding="base"
                    variant={tab === activeTab ? "primary" : "tertiary"}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab}
                  </s-button>
                ))}
              </s-stack>

              <s-stack direction="inline" gap="small" style={{ flexWrap: "wrap" }}>
                {TYPE_OPTIONS.map((type) => (
                  <s-button
                    key={type}
                    padding="base"
                    variant={type === activeType ? "primary" : "tertiary"}
                    onClick={() => setActiveType(type)}
                  >
                    {type}
                  </s-button>
                ))}
              </s-stack>

              <s-box
                padding="base"
                borderWidth="base"
                borderRadius="base"
                style={{ overflowX: "auto" }}
              >
                {visibleRows.length === 0 ? (
                  <s-banner tone="info" padding="base">
                    No discounts match the selected tab and type filters.
                  </s-banner>
                ) : (
                  <table
                    style={{
                      width: "100%",
                      borderCollapse: "collapse",
                      minWidth: "760px",
                    }}
                  >
                    <thead>
                      <tr style={{ textAlign: "left" }}>
                        {["Discount", "Type", "Status", "Value", "Used"].map((heading) => (
                          <th
                            key={heading}
                            style={{
                              padding: "0 0 14px",
                              borderBottom: "1px solid #e5e7eb",
                              fontWeight: 500,
                              color: "#4b5563",
                            }}
                          >
                            {heading}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {visibleRows.map((row) => (
                        <tr key={row.id}>
                          <td
                            style={{
                              padding: "18px 0",
                              borderBottom: "1px solid #e5e7eb",
                              fontWeight: 500,
                            }}
                          >
                            {row.discount}
                          </td>
                          <td style={{ padding: "18px 0", borderBottom: "1px solid #e5e7eb" }}>
                            {row.type}
                          </td>
                          <td style={{ padding: "18px 0", borderBottom: "1px solid #e5e7eb" }}>
                            <s-badge tone={row.statusTone} padding="base">
                              {row.status}
                            </s-badge>
                          </td>
                          <td style={{ padding: "18px 0", borderBottom: "1px solid #e5e7eb" }}>
                            {row.value}
                          </td>
                          <td style={{ padding: "18px 0", borderBottom: "1px solid #e5e7eb" }}>
                            {row.used}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </s-box>
            </s-stack>
          </s-card>
        </s-stack>
      </s-card>
    </s-page>
  );
}
