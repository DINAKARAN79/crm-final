"use client";
/* eslint-disable react-hooks/exhaustive-deps */

import * as React from "react";
import { useRouter } from "next/navigation";
import { readHomeProfile, rememberHomeProfile, userHomePath } from "@/lib/user-home-path";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Menu, LogOut, List, UserRound } from "lucide-react";
import { GlobalSearch } from "@/components/crm/global-search";
import { useAuth } from "@/contexts/auth-context";
import { profileApi } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface AdminHomeProfile {
  id: string;
  name: string;
}

function responseItems(response: any) {
  const data = response?.data?.data ?? response?.data;
  return Array.isArray(data) ? data : data?.profiles ?? [];
}

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  const router = useRouter();
  const { user, tenant, logout, isAdmin, isSuperAdmin } = useAuth();
  const isAuthenticated = Boolean(user);
  const showHomeSelector = isAuthenticated && isAdmin && !isSuperAdmin;
  const [adminHomeOpen, setAdminHomeOpen] = React.useState(false);
  const [userMenuOpen, setUserMenuOpen] = React.useState(false);
  const [userDetailsOpen, setUserDetailsOpen] = React.useState(false);
  const [adminProfiles, setAdminProfiles] = React.useState<AdminHomeProfile[]>([]);
  const [profilesAccessDenied, setProfilesAccessDenied] = React.useState(false);
  const dropdownRefreshId = React.useRef(0);

  const refreshAdminDropdownData = React.useCallback(() => {
    if (!isAuthenticated || !isAdmin || isSuperAdmin) {
      dropdownRefreshId.current += 1;
      setAdminProfiles([]);
      setProfilesAccessDenied(false);
      return;
    }

    const refreshId = ++dropdownRefreshId.current;
    setProfilesAccessDenied(false);
    profileApi.list({ limit: 100 })
      .then((profilesResponse) => {
        const profileItems = responseItems(profilesResponse) as Array<{ id?: string; name?: string }>;
        const uniqueProfiles: AdminHomeProfile[] = Array.from(
          new Map(
            profileItems
              .filter((item) => !!item?.id && !!item?.name)
              .map((item) => [item.id as string, { id: item.id as string, name: item.name as string }])
          ).values()
        ).sort((a, b) => a.name.localeCompare(b.name));

        if (refreshId === dropdownRefreshId.current) {
          setAdminProfiles(uniqueProfiles);
        }
      })
      .catch((error) => {
        if (error?.response?.status === 403) {
          if (refreshId === dropdownRefreshId.current) {
            setAdminProfiles([]);
            setProfilesAccessDenied(true);
          }
          return;
        }
        console.error("Failed to load admin profiles:", error);
      });
  }, [isAdmin, isAuthenticated, isSuperAdmin]);

  React.useEffect(() => {
    refreshAdminDropdownData();
  }, [refreshAdminDropdownData]);

  const handleLogout = async () => {
    await logout();
  };

  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();
  const selectedProfileId = readHomeProfile()?.id;
  const selectedProfile = adminProfiles.find((item) => item.id === selectedProfileId);

  const handleProfileNavigation = (selected: AdminHomeProfile) => {
    setAdminHomeOpen(false);
    rememberHomeProfile(selected);
    router.push(userHomePath(tenant, user?.id));
  };

  const handleAdminHomeNavigation = () => {
    setAdminHomeOpen(false);
    router.push("/dashboard");
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex h-16 min-w-0 max-w-full items-center gap-2 border-b border-sky-100 bg-[#eef8ff] px-3 sm:gap-3 sm:px-4">
        <Button variant="ghost" size="icon" onClick={onMenuClick} className="shrink-0 lg:hidden" aria-label="Open navigation menu">
          <Menu className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-1 justify-center">
          <div className="w-full min-w-0 max-w-3xl">
            <GlobalSearch />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {showHomeSelector && (
            <DropdownMenu
              modal={false}
              open={adminHomeOpen}
              onOpenChange={(isOpen) => {
                setAdminHomeOpen(isOpen);
                if (isOpen) {
                  refreshAdminDropdownData();
                }
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={selectedProfile?.name || "Admin Home"}
                  title={selectedProfile?.name || "Admin Home"}
                  className="h-9 w-9 shrink-0"
                >
                  <List className="h-5 w-5" aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[70vh] w-64 overflow-y-auto">
                <DropdownMenuItem onSelect={handleAdminHomeNavigation} className="text-sm">
                  Admin Home
                </DropdownMenuItem>
                {adminProfiles.length > 0 && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Profiles</DropdownMenuLabel>
                    {adminProfiles.map((item) => (
                      <DropdownMenuItem
                        key={`profile-${item.id}`}
                        onSelect={() => handleProfileNavigation(item)}
                        className="text-sm"
                      >
                        {item.name}
                      </DropdownMenuItem>
                    ))}
                  </>
                )}
                {profilesAccessDenied && (
                  <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
                    You do not have permission to view profiles
                  </p>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <span className="max-w-[7rem] truncate px-2 text-sm sm:max-w-[14rem]" title={displayName || undefined}>
            {displayName}
          </span>
          <DropdownMenu modal={false} open={userMenuOpen} onOpenChange={setUserMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" className="relative h-9 w-9 shrink-0 rounded-full p-0" aria-label="Open user menu">
                <Avatar className="h-9 w-9">
                  {user?.avatar ? <AvatarImage src={user.avatar} alt="" /> : null}
                  <AvatarFallback className="bg-sky-100 text-[#075d91]">
                    <UserRound className="h-5 w-5" aria-hidden="true" />
                  </AvatarFallback>
                </Avatar>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                onSelect={() => {
                  setUserMenuOpen(false);
                  setUserDetailsOpen(true);
                }}
                className="h-auto items-start py-2"
              >
                <span className="truncate text-[13px] font-medium">{displayName || "User"}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => router.push("/profile/sessions")}>
                Sessions
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleLogout} className="text-destructive">
                <LogOut className="mr-2 h-4 w-4" />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Dialog open={userDetailsOpen} onOpenChange={setUserDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Name</DialogTitle>
          </DialogHeader>
          <p className="break-all text-sm font-medium">{displayName || "Not available"}</p>
        </DialogContent>
      </Dialog>
    </>
  );
}