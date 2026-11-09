"use client";

import * as React from "react";
import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const CurrencyInput = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "number", ...props }, ref) => (
    <div className="relative">
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-sm text-muted-foreground">
        ₹
      </span>
      <Input
        {...props}
        ref={ref}
        type={type}
        className={cn(className, "pl-7")}
      />
    </div>
  ),
);

CurrencyInput.displayName = "CurrencyInput";

export { CurrencyInput };
