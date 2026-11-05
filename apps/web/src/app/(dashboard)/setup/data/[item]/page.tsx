import SetupSectionPage from "../../section-page";
import DataOperationPage from "../data-operation-page";

const items = {
  reports: { label: "Reports", description: "Build and review reports for CRM data.", href: "/reports" },
  import: { label: "Data Import", description: "Bring validated CRM records into the platform." },
  update: { label: "Data Update", description: "Update existing CRM records in bulk with a preview-first workflow." },
  export: { label: "Data Export", description: "Export CRM records for analysis and migration." },
  "duplicate-management": { label: "Duplicate Management", description: "Review and resolve duplicate CRM records." },
  "recycle-bin": { label: "Recycle Bin", description: "Review and restore recently deleted CRM records." },
};

export default async function DataSetupPage({ params }: { params: { item: string } }) {
  const item = items[params.item as keyof typeof items];
  if (params.item === "import" || params.item === "update" || params.item === "export") {
    return <DataOperationPage mode={params.item} />;
  }
  return <SetupSectionPage title={item?.label || "Data Administration"} description={item?.description || "Prepare the system for data operations."} items={item ? [item] : Object.values(items)} />;
}