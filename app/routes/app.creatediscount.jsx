import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { authenticate } from "../shopify.server"; // this is the file that contains the shopify api key . It is used to authenticate the user 

function escapeCsvValue(value) {
  const text = String(value ?? "");

  if (/[",\n\r]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

function buildCodesCsv(codes) {
  const rows = [["code"], ...codes.map((code) => [code])];
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\r\n");
}

function createDownloadFilename(title) {
  const safeTitle = String(title ?? "discount-codes")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${safeTitle || "discount-codes"}-codes.csv`;
}

function downloadCsvFile(codes, title) {
  const csv = buildCodesCsv(codes);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = createDownloadFilename(title);
  link.style.display = "none";

  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}



// this is the file that contains the shopify api key . It is used to authenticate the user
// Verify that the request comes from an authenticated Shopify store.
// If the merchant is not logged in or the session is invalid,
// Shopify will automatically redirect them to authenticate.
export const loader = async ({ request }) => {
  try{
    const { admin } = await authenticate.admin(request); 
    const collectionsRes = await admin.graphql(
      `#graphql
      query{
        collections(first: 250) {
          edges {
            node {
              id
              title
            }
          }
        }
      }
      `
    )

    const collectionData = await collectionsRes.json();
    const collections = collectionData?.data?.collections?.edges.map((edge) => edge.node) || [];
    return { ok:true, collections };

  }
  catch(err){
    console.error("Error fetching collections", err);
    return { ok:false, collections:[], error: "Failed to load collections" };
  }
}; 


// Verify the request and return an authenticated Admin API client.
// Use the `admin` object to make GraphQL or REST Admin API requests.
// Runs when this route receives a POST request (for example, from a form submission).
export const action = async ({ request }) => {
  // Use `admin` to interact with the Shopify Admin API.
  const { admin } = await authenticate.admin(request); 
  const formData = await request.formData();

  const title = formData.get("title");
  const discountType = formData.get("discountType");
  const value = Number(formData.get("value"));
  const numberOfCodes = Number(formData.get("numberOfCodes"));
  const codeLength = Number(formData.get("codeLength"));
  const startDate = formData.get("startDate");
  const applyTo = formData.get("applyTo") || "all";
  let selectedCollections = formData.getAll("selectedCollections").filter(Boolean) || [];
  let selectedProducts = formData.getAll("selectedProducts").filter(Boolean) || [];

  const discountValue =
  discountType === "percentage"
    ? { percentage: value / 100 }
    : {
        discountAmount: {
          amount: value.toFixed(2),
          appliesOnEachItem: false,
        },
      };


  function generateCode(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    return Array.from({ length }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  }

  if (!Number.isFinite(numberOfCodes) || !Number.isFinite(codeLength) || numberOfCodes < 1 || codeLength < 1) {
    return { error: "Please enter valid code count and length" };
  }

  //generate codes and put it in codes set untill the size of codes is equal to numberOfCodes , here we use set to remove duplicate codes
  const codes = new Set();
  const maxPossible = Math.pow(36, codeLength);

  while (codes.size < numberOfCodes) {
    if (numberOfCodes > maxPossible * 0.5) {
      return { error: "Code length too short for requested number of codes" };
    }
    codes.add(generateCode(codeLength));
  }

  const [firstCode, ...remainingCodes] = codes;

  // let customerGetsItems ;
  // if(selectedCollections.length > 0){
  //   customerGetsItems = {
  //      collections: {
  //       add: selectedCollections,
  //     },
  //   }; 
  // }else{
  //   customerGetsItems = {
  //     all: true,
  //   };
  // }

  let customerGetsItems;
  if (applyTo === "collection" && selectedCollections.length > 0) {
    customerGetsItems = {
      collections: {
        add: selectedCollections,
      },
    };
  } else if (applyTo === "product" && selectedProducts.length > 0) {
    customerGetsItems = {
      products: {
        productsToAdd: selectedProducts,
      },
    };
  } else {
    customerGetsItems = {
      all: true,
    };
  }

  try {
    const mutation = `#graphql
      mutation CreateDiscount($discount: DiscountCodeBasicInput!){
        discountCodeBasicCreate(basicCodeDiscount: $discount) {
          codeDiscountNode {
            id
          }
          userErrors {
            field 
            message
          }
        }
      }
    `;

    const variables = {
      discount: {
        title,
        startsAt: startDate,
        code: firstCode,
        customerGets: {
          value: discountValue,
          items: customerGetsItems,
        },
        customerSelection: {
          all: true,
        },
      },
    };

    const createRes = await admin.graphql(mutation, { variables });
    const createJson = await createRes.json();
    const discountId = createJson.data.discountCodeBasicCreate?.codeDiscountNode?.id;

    if (!discountId) {
      return {
        error: "Discount creation failed",
        userErrors: createJson.data.discountCodeBasicCreate?.userErrors,
      };
    }

    if (remainingCodes.length > 0) {
      for (const code of remainingCodes) {
        await admin.graphql(
          `#graphql
            mutation AddCodes($discountId: ID!, $codes: [DiscountRedeemCodeInput!]!){
              discountRedeemCodeBulkAdd(discountId: $discountId, codes: $codes) {
                userErrors {
                  field
                  message
                }
              }
            }
          `,
          {
            variables: {
              discountId,
              codes: [{ code }],
            },
          }
        );
      }
    }

    return {
      success: true,
      codes: [...codes],
      appliedToType: applyTo,
      selectionCount:
        applyTo === "collection"
          ? selectedCollections.length
          : applyTo === "product"
            ? selectedProducts.length
            : 0,
      appliedToCollections: applyTo === "collection" && selectedCollections.length > 0,
      collectionCount: selectedCollections.length,
      appliedToProducts: applyTo === "product" && selectedProducts.length > 0,
      productCount: selectedProducts.length,
    };
  } catch (err) {
    return { error: err.message };
  }

};



// front end code
export default function CreateDiscountUI(){
  const fetcher = useFetcher();
  const [title,setTitle] = useState("Bulk discount Offer");
  const [discountType, setDiscountType] = useState("percentage");
  const [value, setValue] = useState(10);
  const [numberOfCodes, setNumberOfCodes] = useState(5);
  const [codeLength, setCodeLength] = useState(8);
  const [startDate, setStartDate] = useState(new Date().toISOString().split("T")[0]);
  const [applyTo, setApplyTo] = useState("all");
  const [selectedCollections, setSelectedCollections] = useState([]);
  const [selectedProducts, setSelectedProducts] = useState([]);

  const [codes, setCodes] = useState([]);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  // open collection picker (shopify resource picker)
  const openCollectionPicker = async () => {
    try{
      const selected = await window.shopify.resourcePicker({
        type: "collection",
        multiple: true,
      })

      if(selected && selected.length > 0){
        setSelectedCollections(selected);
        console.log("Selected collections", selected);
      }
    }
    catch(err){
      console.error("Collection picker error", err);
    }
  };

  const openProductPicker = async () => {
    try {
      const selected = await window.shopify.resourcePicker({
        type: "product",
        multiple: true,
      });

      if (selected && selected.length > 0) {
        setSelectedProducts(selected);
      }
    } catch (err) {
      console.error("Product picker error", err);
    }
  };

  const removeCollection = (idRemove) => {
    setSelectedCollections((prev) => prev.filter((col) => col.id !== idRemove));
  };

  const removeProduct = (idRemove) => {
    setSelectedProducts((prev) => prev.filter((product) => product.id !== idRemove));
  };

  const handleDownloadCsv = () => {
    if (codes.length === 0) {
      return;
    }

    downloadCsvFile(codes, title);
  };

  useEffect(()=>{
    if(!fetcher.data) return;

    if (fetcher.data.error){
      setError(fetcher.data.error);
      setToast("");
      setCodes([]);
    }
    else if (fetcher.data.success){
      setCodes(fetcher.data.codes); 
      const targetLabel =
        fetcher.data.appliedToType === "collection"
          ? `(applied to ${fetcher.data.selectionCount} collection(s))`
          : fetcher.data.appliedToType === "product"
            ? `(applied to ${fetcher.data.selectionCount} product(s))`
            : "(applied to all products)";
      setToast(`✅ Discount codes created successfully ${targetLabel}`);
      setError("");
    }
  },[fetcher.data]); 

  function submit(){
    setError("");
    setToast("");
    setCodes([]);

    const formData = new FormData();
    formData.append("title", title);
    formData.append("discountType", discountType);
    formData.append("value", value.toString());
    formData.append("numberOfCodes", numberOfCodes.toString());
    formData.append("codeLength", codeLength.toString());
    formData.append("startDate", startDate);
    formData.append("applyTo", applyTo);

    if (applyTo === "collection") {
      selectedCollections.forEach((col) => {
        formData.append("selectedCollections", col.id);
      });
    } else if (applyTo === "product") {
      selectedProducts.forEach((product) => {
        formData.append("selectedProducts", product.id);
      });
    }

    fetcher.submit(formData,{
      method: "POST",
      action: "/app/creatediscount"
    });

  }

  return(
    <s-page heading="Bulk discount code generator" padding="base">
      <s-section heading="Create Discount codes" padding="base">
        <s-card padding="base">
          <s-stack gap="base">
            <s-text-field padding="base" label="Title" value={title} onChange={(e)=>setTitle(e.target.value)}/>
            <s-select padding="base" label="Discount type" placeholder="Select discount type" value={discountType} onChange={(e)=>setDiscountType(e.target.value)}>
              <s-option value="percentage">Percentage</s-option>
              <s-option value="Fixed">Fix Amount</s-option>
            </s-select>

            <s-text-field padding="base" label="Discount value" type="number" value={value} onChange={(e)=>setValue(e.target.value)}/>
            <s-text-field padding="base" label="Number of codes" type="number" value={numberOfCodes} onChange={(e)=>setNumberOfCodes(Number(e.target.value))}/>
            <s-text-field padding="base" label="Code length" type="number" value={codeLength} onChange={(e)=>setCodeLength(Number(e.target.value))}/>
            <s-text-field padding="base" label="Start date" type="date" value={startDate} onChange={(e)=>setStartDate(e.target.value)}/>
            <s-select padding="base" label="Apply discount to" value={applyTo} onChange={(e)=>setApplyTo(e.target.value)}>
              <s-option value="all">All products</s-option>
              <s-option value="collection">Specific collections</s-option>
              <s-option value="product">Specific products</s-option>
            </s-select>

            {applyTo === "collection" && (
              <>
                <div style={{marginBottom: '16px'}}>
                  <s-button variant="secondary" onClick={openCollectionPicker} padding="base">
                    {selectedCollections.length > 0 ? `Selected ${selectedCollections.length} Collection(s)` : "+ Select Collections"}
                  </s-button>
                </div>

                {selectedCollections.length > 0 && (
                  <s-card tone="subdued" padding="base">
                    <s-text variant="bodyMd" padding="base">
                      ✅ Selected collections: {selectedCollections.length}
                    </s-text>
                    <s-stack direction="inline" gap="small" padding="base">
                      {selectedCollections.map((col) => (
                        <s-clickable-chip
                          key={col.id}
                          removable
                          onRemove={() => removeCollection(col.id)}
                        >
                          {col.title}
                        </s-clickable-chip>
                      ))}
                    </s-stack>
                  </s-card>
                )}

                {selectedCollections.length === 0 && (
                  <s-banner tone="info" padding="base">
                    No collections selected - discount codes will be applied to all products
                  </s-banner>
                )}
              </>
            )}

            {applyTo === "product" && (
              <>
                <div style={{marginBottom: '16px'}}>
                  <s-button variant="secondary" onClick={openProductPicker} padding="base">
                    {selectedProducts.length > 0 ? `Selected ${selectedProducts.length} Product(s)` : "+ Select Products"}
                  </s-button>
                </div>

                {selectedProducts.length > 0 && (
                  <s-card tone="subdued" padding="base">
                    <s-text variant="bodyMd" padding="base">
                      ✅ Selected products: {selectedProducts.length}
                    </s-text>
                    <s-stack direction="inline" gap="small" padding="base">
                      {selectedProducts.map((product) => (
                        <s-clickable-chip
                          key={product.id}
                          removable
                          onRemove={() => removeProduct(product.id)}
                        >
                          {product.title}
                        </s-clickable-chip>
                      ))}
                    </s-stack>
                  </s-card>
                )}

                {selectedProducts.length === 0 && (
                  <s-banner tone="info" padding="base">
                    No products selected - discount codes will be applied to all products
                  </s-banner>
                )}
              </>
            )}

            {applyTo === "all" && (
              <s-banner tone="info" padding="base">
                Discount codes will be applied to all products
              </s-banner>
            )}

            <s-button onClick={submit} padding="base" variant="primary" disabled={fetcher.state==="submitting"}>
              {fetcher.state === "submitting" ? "Creating..." : "Generate Discount Codes"}
            </s-button>
             
            {fetcher.state==="submitting" && <s-progress indeterminate padding="base"  />}
            {error && <s-banner tone="critical" padding="base">{error}</s-banner>}
            {toast && <s-banner tone="success" padding="base">{toast}</s-banner>}
          </s-stack> 
        </s-card>
      </s-section>

      {codes.length > 0 &&
        (
          <s-section heading="Discount codes" padding="base">
            <s-box padding="base" style={{ display: "flex", justifyContent: "flex-end" }} tone="success">
              <s-button variant="primary" onClick={handleDownloadCsv} padding="base">
                Download CSV
              </s-button>
            </s-box>
            <s-card padding="base">
              <s-stack gap="base">
                <s-unordered-list padding="base">
                  {codes.map((code) => (
                    <s-list-item key={code} padding="base">
                      <s-badge tone="neutral" icon="discount" key={code} padding="base">
                        {code}
                      </s-badge>
                    </s-list-item>
                  ))}
                </s-unordered-list>
              </s-stack>
            </s-card>
          </s-section>

        )
      }
    </s-page>
  ) 
}
