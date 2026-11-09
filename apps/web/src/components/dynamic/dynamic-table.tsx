"use client";

import * as React from "react";
import { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTable } from "@/components/crm/data-table";
import { FieldDefinition } from "./field-renderer";
import { MoreHorizontal, Eye, Edit, Trash2 } from "lucide-react";
import { formatDate as formatTenantDate, formatDateTime as formatTenantDateTime } from "@/lib/date-format";

interface DynamicTableProps {
  objectName: string;
  objectLabel: string;
  pluralLabel: string;
  fields: FieldDefinition[];
  data: any[];
  isLoading?: boolean;
  totalItems?: number;
  currentPage?: number;
  onPageChange?: (page: number) => void;
  onSearch?: (query: string) => void;
  onSort?: (field: string, direction: "asc" | "desc") => void;
  onView?: (record: any) => void;
  onEdit?: (record: any) => void;
  onDelete?: (record: any) => void;
  canCreate?: boolean;
  canUpdate?: boolean;
  canDelete?: boolean;
  basePath?: string;
}

function formatCellValue(value: any, field: FieldDefinition): React.ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;

  switch (field.fieldType) {
    case "currency":
      return (
        <span className="font-medium">
          {new Intl.NumberFormat("en-IN", {
            style: "currency",
            currency: "INR",
            maximumFractionDigits: 0,
          }).format(Number(value))}
        </span>
      );

    case "percentage":
      return <span>{value}%</span>;

    case "boolean":
      return (
        <Badge variant={value ? "default" : "secondary"}>
          {value ? "Yes" : "No"}
        </Badge>
      );

    case "date":
      try {
        return (
          <span>
            {formatTenantDate(String(value))}
          </span>
        );
      } catch {
        return <span>{String(value)}</span>;
      }

    case "dateTime":
      try {
        return (
          <span>
            {formatTenantDateTime(String(value))}
          </span>
        );
      } catch {
        return <span>{String(value)}</span>;
      }

    case "picklist": {
      const pv = field.picklistValues?.find((p) => p.value === value);
      const colorMap: Record<string, string> = {
        NEW: "bg-blue-100 text-blue-800",
        ACTIVE: "bg-green-100 text-green-800",
        INACTIVE: "bg-red-100 text-red-800",
        PENDING: "bg-yellow-100 text-yellow-800",
        COMPLETED: "bg-green-100 text-green-800",
        CANCELLED: "bg-red-100 text-red-800",
        QUALIFIED: "bg-green-100 text-green-800",
        UNQUALIFIED: "bg-gray-100 text-gray-800",
        CONTACTED: "bg-blue-100 text-blue-800",
        CONVERTED: "bg-purple-100 text-purple-800",
        AVAILABLE: "bg-green-100 text-green-800",
        BOOKED: "bg-blue-100 text-blue-800",
        SOLD: "bg-red-100 text-red-800",
        HOLD: "bg-yellow-100 text-yellow-800",
        RESERVED: "bg-orange-100 text-orange-800",
      };
      const colorClass = colorMap[value] || "bg-gray-100 text-gray-800";
      return <Badge className={colorClass}>{pv?.label || String(value)}</Badge>;
    }

    case "multiPicklist":
      if (Array.isArray(value)) {
        return (
          <div className="flex flex-wrap gap-1">
            {value.slice(0, 2).map((v) => {
              const pv = field.picklistValues?.find((p) => p.value === v);
              return (
                <Badge key={v} variant="outline" className="text-xs">
                  {pv?.label || v}
                </Badge>
              );
            })}
            {value.length > 2 && (
              <Badge variant="outline" className="text-xs">
                +{value.length - 2}
              </Badge>
            )}
          </div>
        );
      }
      return <span>{String(value)}</span>;

    case "email":
      return (
        <a
          href={`mailto:${value}`}
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>
      );

    case "phone":
      return (
        <a
          href={`tel:${value}`}
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value)}
        </a>
      );

    case "url":
      return (
        <a
          href={String(value)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {String(value).replace(/^https?:\/\//, "").slice(0, 30)}
        </a>
      );

    default:
      return <span>{String(value).slice(0, 50)}</span>;
  }
}

export function DynamicTable({
  objectName,
  objectLabel,
  pluralLabel,
  fields,
  data,
  isLoading = false,
  totalItems = 0,
  currentPage = 1,
  onPageChange,
  onSearch,
  onView,
  onEdit,
  onDelete,
  canCreate = true,
  canUpdate = true,
  canDelete = true,
  basePath,
}: DynamicTableProps) {
  const router = useRouter();
  const displayFields = fields.filter(
    (f) => f.visible && !["id", "is_active", "created_by", "updated_at"].includes(f.name)
  );

  const columns: ColumnDef<any>[] = [
    ...displayFields.slice(0, 8).map((field) => ({
      accessorKey: `data.${field.name}`,
      header: field.label,
      cell: ({ row }: { row: any }) => {
        const record = row.original;
        const value = record.data?.[field.name];
        return formatCellValue(value, field);
      },
      enableSorting: field.sortable,
    })),
    {
      id: "actions",
      cell: ({ row }: { row: any }) => {
        const record = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  onView
                    ? onView(record)
                    : basePath
                    ? router.push(`${basePath}/${record.id}`)
                    : undefined
                }
              >
                <Eye className="mr-2 h-4 w-4" />
                View
              </DropdownMenuItem>
              {canUpdate && (
                <DropdownMenuItem onClick={() => onEdit?.(record)}>
                  <Edit className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => onDelete?.(record)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={data}
      searchKey={displayFields[0]?.name}
      searchPlaceholder={`Search ${pluralLabel.toLowerCase()}...`}
        isLoading={isLoading}
        totalItems={totalItems}
        currentPage={currentPage}
        onPageChange={onPageChange}
        serverPagination
      />
  );
}
