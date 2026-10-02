/**
 * Todo feature — single todo row.
 */

import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import Tooltip from '@mui/material/Tooltip';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { TodoItem as TodoItemType } from './todoTypes';
import { isDueToday, isOverdue } from './todoUtils';

interface Props {
  item: TodoItemType;
  onToggleDone: (item: TodoItemType) => void;
  onMarkDoing: (item: TodoItemType) => void;
  onEdit: (item: TodoItemType) => void;
  onDelete: (item: TodoItemType) => void;
}

const PRIORITY_COLOR = {
  high: 'error',
  medium: 'warning',
  low: 'success',
} as const;

function priorityLabel(t: (k: string) => string, priority: string): string {
  return t(
    `core:todoPriority${priority.charAt(0).toUpperCase()}${priority.slice(1)}`,
  );
}

function TodoItem({
  item,
  onToggleDone,
  onMarkDoing,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const theme = useTheme();
  const done = item.status === 'done';
  const doing = item.status === 'doing';
  const overdue = isOverdue(item);
  const dueToday = isDueToday(item);

  const dueMeta: string[] = [];
  if (item.dueDate) {
    let due = item.dueDate;
    if (item.dueTime) due += ` ${item.dueTime}`;
    if (overdue) due += ` · ${t('core:todoOverdue')}`;
    else if (dueToday) due += ` · ${t('core:todoDueToday')}`;
    dueMeta.push(due);
  }
  if (item.project) dueMeta.push(item.project);

  let dueColor: 'error' | 'primary' | 'text.secondary' = 'text.secondary';
  if (overdue) dueColor = 'error';
  else if (dueToday) dueColor = 'primary';

  return (
    <ListItem
      dense
      secondaryAction={
        <Box sx={{ display: 'flex', alignItems: 'center' }}>
          {!done && (
            <Tooltip title={t('core:todoMarkDoing')}>
              <IconButton size="small" onClick={() => onMarkDoing(item)}>
                <PlayArrowOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title={t('core:todoEdit')}>
            <IconButton size="small" onClick={() => onEdit(item)}>
              <EditOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <Tooltip title={t('core:todoDelete')}>
            <IconButton size="small" onClick={() => onDelete(item)}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
      }
    >
      <ListItemIcon sx={{ minWidth: 36 }}>
        <Checkbox
          edge="start"
          checked={done}
          onChange={() => onToggleDone(item)}
          size="small"
          data-tid="todoItemToggleDone"
        />
      </ListItemIcon>
      <ListItemText
        primary={
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              flexWrap: 'wrap',
            }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor:
                  theme.palette[PRIORITY_COLOR[item.priority]].main,
                flexShrink: 0,
              }}
            />
            <Typography
              variant="body2"
              sx={{
                textDecoration: done ? 'line-through' : 'none',
                color: done ? 'text.disabled' : 'text.primary',
                wordBreak: 'break-word',
              }}
            >
              {item.title}
            </Typography>
            {doing && (
              <Chip
                label={t('core:todoDoing')}
                size="small"
                color="info"
                variant="outlined"
                sx={{ height: 18, fontSize: 11 }}
              />
            )}
          </Box>
        }
        secondary={
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.5,
              flexWrap: 'wrap',
              mt: 0.25,
            }}
          >
            {dueMeta.length > 0 && (
              <Typography
                variant="caption"
                color={dueColor}
                sx={{ fontWeight: overdue ? 600 : 'inherit' }}
              >
                {dueMeta.join(' · ')}
              </Typography>
            )}
            {item.tags.map((tag) => (
              <Chip
                key={tag}
                label={`#${tag}`}
                size="small"
                sx={{ height: 18, fontSize: 11 }}
              />
            ))}
            <Chip
              label={priorityLabel(t, item.priority)}
              size="small"
              variant="outlined"
              color={PRIORITY_COLOR[item.priority]}
              sx={{ height: 18, fontSize: 11 }}
            />
            {done && (
              <Tooltip title={t('core:todoRestore')}>
                <IconButton
                  size="small"
                  sx={{ p: 0 }}
                  onClick={() => onToggleDone(item)}
                >
                  <UndoIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        }
      />
    </ListItem>
  );
}

export default TodoItem;
