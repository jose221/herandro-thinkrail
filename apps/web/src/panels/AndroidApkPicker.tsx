import { RiArrowUpLine, RiFileLine, RiFolderLine, RiFolderOpenLine } from "@remixicon/react";
import type { FileNode } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@thinkrail/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { useCallback, useMemo, useState } from "react";
import { ancestorPaths } from "../lib/utils";
import { getTransport } from "../transport";
import { useWorkspaceRead } from "./useWorkspaceRead";

export function apkPickerEntries(nodes: readonly FileNode[]): FileNode[] {
	return nodes.filter((node) => node.kind === "dir" || /\.apk$/i.test(node.name));
}

export function AndroidApkPicker({
	workspaceId,
	value,
	disabled,
	onSelect,
}: {
	workspaceId: string;
	value: string;
	disabled: boolean;
	onSelect: (path: string) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [directory, setDirectory] = useState(".");
	const [nodes, setNodes] = useState<FileNode[]>([]);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);
	const entries = useMemo(() => apkPickerEntries(nodes), [nodes]);
	const directories = entries.filter((node) => node.kind === "dir");
	const apks = entries.filter((node) => node.kind === "file");
	const readDirectory = useCallback((id: string, path: string | undefined) => {
		setLoading(true);
		return getTransport().request("fs.readDir", { workspaceId: id, path: path ?? "." });
	}, []);
	useWorkspaceRead(
		open ? workspaceId : null,
		readDirectory,
		{
			onResult: (nextNodes) => {
				setNodes(nextNodes);
				setLoading(false);
				setFailed(false);
			},
			onFailure: () => {
				setNodes([]);
				setLoading(false);
				setFailed(true);
			},
			onSwitch: () => {
				setNodes([]);
				setLoading(false);
				setFailed(false);
			},
		},
		directory,
	);

	return (
		<>
			<div className="flex min-w-0 flex-1 gap-8">
				<input
					aria-label={t("androidEmulator.apkPath")}
					data-testid="android-emulator-apk-path"
					readOnly
					value={value}
					placeholder={t("androidEmulator.apkPlaceholder")}
					title={value || undefined}
					className="min-h-32 min-w-0 flex-1 rounded-sm border border-border-default bg-control-bg px-8 text-text-default tr-text-ui"
				/>
				<Button
					type="button"
					variant="outline"
					size="m"
					iconLeft={RiFolderOpenLine}
					disabled={disabled}
					data-testid="android-emulator-apk-browse"
					onClick={() => {
						setDirectory(".");
						setOpen(true);
					}}
				>
					{t("androidEmulator.browseApk")}
				</Button>
			</div>
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!disabled) setOpen(nextOpen);
				}}
			>
				<DialogContent
					data-testid="android-apk-picker"
					className="max-h-[calc(100dvh-2rem)] max-w-[32rem] overflow-y-auto"
				>
					<DialogHeader>
						<DialogTitle>{t("androidEmulator.chooseApk")}</DialogTitle>
						<DialogDescription>{t("androidEmulator.chooseApkDescription")}</DialogDescription>
					</DialogHeader>
					<div className="flex min-w-0 items-center gap-8">
						<Button
							type="button"
							variant="outline"
							size="s"
							iconLeft={RiArrowUpLine}
							disabled={directory === "."}
							data-testid="android-apk-picker-parent"
							onClick={() => setDirectory(ancestorPaths(directory).at(-1) ?? ".")}
						>
							{t("androidEmulator.parentFolder")}
						</Button>
						<code
							data-testid="android-apk-picker-path"
							className="min-w-0 flex-1 truncate text-text-muted tr-code-text"
						>
							{directory === "." ? t("androidEmulator.projectRoot") : directory}
						</code>
					</div>
					{failed ? (
						<p role="alert" className="text-feedback-error tr-text-metadata">
							{t("androidEmulator.directoryLoadFailed")}
						</p>
					) : null}
					{loading ? (
						<p role="status" className="text-text-muted tr-text-metadata">
							{t("androidEmulator.loadingFiles")}
						</p>
					) : null}
					{!loading && !failed && apks.length === 0 ? (
						<p className="text-text-muted tr-text-metadata">{t("androidEmulator.noApkFiles")}</p>
					) : null}
					<Command className="min-h-0 bg-transparent">
						<CommandInput
							aria-label={t("androidEmulator.searchFiles")}
							placeholder={t("androidEmulator.searchFiles")}
						/>
						<CommandList className="max-h-[min(50dvh,24rem)]">
							<CommandEmpty>{t("androidEmulator.noMatches")}</CommandEmpty>
							{directories.length > 0 ? (
								<CommandGroup heading={t("androidEmulator.folders")}>
									{directories.map((node) => (
										<CommandItem
											key={node.path}
											value={`${node.name} ${node.path}`}
											data-testid="android-apk-picker-directory"
											data-path={node.path}
											onSelect={() => setDirectory(node.path)}
										>
											<RiFolderLine className="size-14 shrink-0" />
											<span className="min-w-0 truncate">{node.name}</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
							{apks.length > 0 ? (
								<CommandGroup heading={t("androidEmulator.apkFiles")}>
									{apks.map((node) => (
										<CommandItem
											key={node.path}
											value={`${node.name} ${node.path}`}
											data-testid="android-apk-picker-file"
											data-path={node.path}
											onSelect={() => {
												onSelect(node.path);
												setOpen(false);
											}}
										>
											<RiFileLine className="size-14 shrink-0" />
											<span className="min-w-0 truncate">{node.name}</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
						</CommandList>
					</Command>
				</DialogContent>
			</Dialog>
		</>
	);
}
