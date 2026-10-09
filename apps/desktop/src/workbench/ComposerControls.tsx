import { useState, type ReactNode } from "react";
import type {
  ProfileCatalog,
  ProviderProfile,
  WorkMode,
  PermissionMode,
} from "../generated/contracts";
import { useWords } from "../workspaceClient";
import { Menu, Select } from "./Menu";
import { Icon } from "./Icon";
import { Popover } from "./Popover";
export function ComposerControls({
  catalog,
  profile,
  model,
  mode,
  permission,
  inheritedPermission,
  onProfile,
  onMode,
  onPermission,
  onPermissionDetails,
  disabled,
  onModels,
  children,
  attachment,
}: {
  catalog: ProfileCatalog;
  profile: string;
  model: ProviderProfile | null;
  mode: WorkMode;
  permission: PermissionMode | null;
  inheritedPermission?: PermissionMode | null;
  onProfile: (value: string) => void;
  onMode: (value: WorkMode) => void;
  onPermission?: (value: PermissionMode | null) => void;
  onPermissionDetails?: () => void;
  disabled?: boolean;
  onModels: () => void;
  children?: ReactNode;
  attachment?: ReactNode;
}) {
  const tr = useWords(),
    [context, setContext] = useState<HTMLElement | null>(null);
  const [thinking, setThinking] = useState<HTMLElement | null>(null);
  const permissions = [
    {
      value: "request_approval",
      label: tr("请求审批", "Request approval"),
      description: tr(
        "需要授权的操作交由你确认",
        "Ask you to confirm actions that require approval",
      ),
    },
    {
      value: "auto_review",
      label: tr("帮我批准", "Review for me"),
      description: tr("先审查，不确定时交由你决定", "Review first; ask you when uncertain"),
    },
    {
      value: "full_access",
      label: tr("完全访问", "Full access"),
      description: tr(
        "在系统与服务已有权限内执行",
        "Act within existing OS and service permissions",
      ),
    },
  ];
  const effective = permission || inheritedPermission;
  const permissionLabel =
    permissions.find((p) => p.value === effective)?.label || tr("继承权限", "Inherited permission");
  const effort = model?.options.reasoning_effort;
  const effortLabel =
    (
      { low: tr("低", "Low"), medium: tr("中", "Medium"), high: tr("高", "High") } as Record<
        string,
        string
      >
    )[effort || ""] ||
    effort ||
    tr("默认", "Default");
  return (
    <div className="wb-composer-toolbar">
      <div className="wb-composer-options wb-composer-left">
        {attachment}
        {onPermission ? (
          <Select
            compact
            label={tr("任务权限", "Task permission")}
            icon="shield"
            value={permission || ""}
            display={permissionLabel}
            disabled={disabled}
            options={[
              { value: "", label: tr("继承项目 / 全局设置", "Inherit project / global default") },
              ...permissions,
              ...(onPermissionDetails
                ? [
                    {
                      value: "__scope",
                      label: tr("文件夹与审批设置…", "Folder and approval settings…"),
                    },
                  ]
                : []),
            ]}
            onChange={(value) =>
              value === "__scope"
                ? onPermissionDetails?.()
                : onPermission((value || null) as PermissionMode | null)
            }
          />
        ) : (
          <button
            type="button"
            className="wb-option wb-permission"
            onClick={onPermissionDetails}
            title={tr("查看有效权限与审批", "View permissions and approvals")}
          >
            <Icon name="shield" />
            <span>{permissionLabel}</span>
            <Icon name="down" />
          </button>
        )}
        <Select
          compact
          label={tr("工作模式", "Work mode")}
          value={mode}
          disabled={disabled}
          onChange={(value) => onMode(value as WorkMode)}
          options={[
            {
              value: "chat",
              label: tr("聊天", "Chat"),
              description: tr("讨论和阅读，不修改文件", "Discuss and read without changing files"),
            },
            { value: "plan", label: tr("先规划再执行", "Plan first") },
            { value: "execute", label: tr("直接执行", "Execute") },
          ]}
        />
      </div>
      <div className="wb-composer-options wb-composer-right">
        <button
          type="button"
          className="wb-context-ring"
          aria-label={tr("上下文使用情况", "Context usage")}
          title={tr("上下文比例暂不可用", "Context ratio unavailable")}
          onClick={(e) => setContext(context ? null : e.currentTarget)}
          aria-haspopup="dialog"
          aria-expanded={!!context}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle className="wb-context-track" cx="12" cy="12" r="9" />
            <circle className="wb-context-used" cx="12" cy="12" r="9" strokeDasharray="2 4" />
          </svg>
        </button>
        <Select
          compact
          label={tr("任务模型", "Task model")}
          value={profile}
          disabled={disabled}
          display={
            model?.label ||
            (profile
              ? catalog.profiles.find((p) => p.profile.id === profile)?.profile.label
              : tr("默认模型", "Default model"))
          }
          options={[
            {
              value: "",
              label: tr("继承默认模型", "Inherit default model"),
              description: model?.model,
            },
            ...catalog.profiles.map(({ profile: p }) => ({
              value: p.id,
              label: p.label,
              description: p.model,
            })),
          ]}
          onChange={onProfile}
        />
        <button
          type="button"
          className="wb-option wb-thinking-option"
          title={tr(
            "思考等级来自模型服务配置，点击管理",
            "Reasoning level comes from the model profile; click to manage",
          )}
          aria-haspopup="menu"
          aria-expanded={!!thinking}
          onClick={(e) => setThinking(thinking ? null : e.currentTarget)}
        >
          {tr("思考：", "Thinking: ")}
          {effortLabel}
          <Icon name="down" />
        </button>
        {children}
      </div>
      {context && (
        <Popover
          anchor={context}
          label={tr("上下文使用情况", "Context usage")}
          onClose={() => setContext(null)}
        >
          <div className="wb-context-card">
            <div className="wb-context-amount">
              <strong>—</strong>
              <span>{tr("使用比例暂不可用", "Usage unavailable")}</span>
            </div>
            <div className="wb-context-meter" />
            <p>
              {tr(
                "当前服务尚未提供可用于计算比例的上下文容量和实际占用。这里不会用估算数字冒充真实比例。",
                "The service has not provided both context capacity and actual occupancy. A ratio cannot be shown yet.",
              )}
            </p>
            <p>
              {tr(
                "任务目标、对话及工具记录仍会按现有规则保存；较早内容整理后，原始记录仍可查阅。",
                "Goals, conversation and tool records are retained. Original records remain available after context compaction.",
              )}
            </p>
            <button type="button" onClick={() => setContext(null)}>
              {tr("知道了", "Got it")}
            </button>
          </div>
        </Popover>
      )}
      {thinking && (
        <Menu
          anchor={thinking}
          label={tr("思考等级", "Thinking level")}
          items={[
            {
              value: "current",
              label: effortLabel,
              description: tr(
                "当前生效值，来自模型服务配置",
                "Current value from the model profile",
              ),
              disabled: true,
            },
            {
              value: "manage",
              label: tr("配置模型的思考等级…", "Configure model thinking level…"),
              icon: "settings",
            },
          ]}
          onPick={onModels}
          onClose={() => setThinking(null)}
        />
      )}
    </div>
  );
}
