import { redirect, useLoaderData, useNavigate } from "react-router";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const navigate = useNavigate();

  return (
    <AppProvider embedded={false}>
      <s-page heading="Welcome to Bulk Discount App" padding="wide" >
        <s-stack
          direction="block"
          alignItems="center"
          justifyContent="center"
          minBlockSize="70vh"
          
        >
          <s-box
            maxInlineSize="540px"
            inlineSize="100%"
            padding="large-500"
            borderWidth="base"
            borderColor="base"
            borderRadius="large"
          >
            <s-stack direction="block" gap="large" alignItems="center">
              <svg width="150" height="120" viewBox="0 0 150 120" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="0" y="0" width="150" height="120" rx="24" fill="#EEF2FF" />
                <rect x="24" y="24" width="102" height="64" rx="12" fill="#ffffff" />
                <path d="M38 52H112" stroke="#4338CA" strokeWidth="10" strokeLinecap="round" />
                <path d="M38 76H92" stroke="#6366F1" strokeWidth="10" strokeLinecap="round" />
                <circle cx="112" cy="86" r="16" fill="#4338CA" />
                <circle cx="112" cy="86" r="28" fill="#C7D2FE" opacity="0.6" />
              </svg>

              <s-stack direction="block" gap="small" alignItems="center">
                <s-heading level="2">Create discount codes in bulk</s-heading>
                <s-text tone="subdued">
                  Your shop is ready to generate discount codes fast and easily.
                </s-text>
              </s-stack>

              <s-button variant="primary" onClick={() => navigate("/app/creatediscount")}>
                Create Discount
              </s-button>
            </s-stack>
          </s-box>
        </s-stack>
      </s-page>
    </AppProvider>
  );
}